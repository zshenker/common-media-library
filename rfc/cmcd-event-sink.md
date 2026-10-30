---
status: draft
---

# RFC: Event sinks and time-based batching for `createCmcdSession()`

|                     |                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Author**          | Zac Shenker                                                                                                           |
| **Date**            | 2026-10-30                                                                                                            |
| **Package**         | `@svta/cml-cmcd`                                                                                                      |
| **Depends on**      | [RFC: CMCD session](https://github.com/streaming-video-technology-alliance/common-media-library/pull/486) (PR #486) |
| **Breaking change** | No                                                                                                                    |

## Summary

The CMCD session of PR #486 sends event reports only as HTTP POST requests to a collector URL. This RFC adds two options to its event targets:

- `sink`: a function that receives each batch as prepared CMCD data. A target has either a `url` or a `sink`.
- `batchInterval`: the maximum time in seconds that a report waits in a batch.

```ts
import type { CmcdEventSink } from '@svta/cml-cmcd'
import { CmcdEventType, createCmcdSession } from '@svta/cml-cmcd'

declare function publishRecords(records: { T: number; data: object }[]): Promise<void>

const sink: CmcdEventSink = async (reports) => {
	await publishRecords(reports.map(({ ts, ...data }) => ({ T: ts as number, data })))
}

const session = createCmcdSession({
	eventTargets: [
		{
			sink,
			events: [CmcdEventType.PLAY_STATE],
			enabledKeys: ['sid', 'sta', 'bl'],
			batchInterval: 60,
		},
	],
})
```

This RFC changes no rule of PR #486. It reuses the destinations, the delivery table, and the configuration checks of the session.

## Motivation

The individual draft [CMCD over MSF Event Timeline](https://wilaw.github.io/CMCD-over-MSF-event-timeline/draft-wilaw-moq-cmcd-event-timeline.html) defines how a player sends CMCD v2 event reports over Media over QUIC (MoQ). The MSF catalog lists CMCD tracks in `publishTracks`. The player publishes the reports as Event Timeline records. The draft has these requirements:

1. Reports go to a MoQ track, not to an HTTP URL.
2. The value of `ts` becomes the `T` time index of the record and is not part of the record data.
3. A Group of records is published when it reaches `batchCount` records or when `batchInterval` ends, whichever happens first.

The session cannot meet these requirements:

- The `requester` receives an `HttpRequest` with the encoded text body. A MoQ player must decode every line again and must return HTTP status codes that it invents, to control the back-off.
- An event target needs a non-empty `url`. A MoQ target has a namespace and a track name.
- Batching is by count only.

The same gaps apply to other transports that are not HTTP, such as WebSocket. A sink keeps the sequence numbers, the `msd` gate, the waiting values, the `filter`, the queue, and the back-off of the session for every transport.

## Guide-level explanation

### Send reports to a sink

Give the event target a `sink` instead of a `url`. The session calls the sink with each batch.

Each report is the prepared CMCD data of one event, in the form that `prepareCmcdData` returns. The session has already applied `enabledKeys`, the `filter`, the waiting values, and the keys that the session writes. Every report contains `e`, `ts`, `sid`, and `v`. A token value is an `SfToken` instance, and an inner list is an array. Serialize a report with `encodeSfDict`, not with `JSON.stringify`.

The promise of the sink takes the place of the HTTP response in the delivery table of PR #486:

| Sink result                    | Same action as   | Session action                                                              |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------- |
| Resolves                       | 2xx              | The batch is delivered. The wait resets.                                    |
| Resolves with `{ gone: true }` | 410              | Every target of that destination stops for the life of the session.         |
| Rejects or throws              | 429, 5xx         | The batch returns to the front of the queue, and the target waits.          |

The sink has no result that drops a batch. To drop a batch that can never succeed, the sink resolves.

### Batch by time

```ts
import { CmcdEventType, createCmcdSession } from '@svta/cml-cmcd'

const session = createCmcdSession({
	eventTargets: [
		{
			url: 'https://collector.example.com/cmcd',
			events: [CmcdEventType.PLAY_STATE, CmcdEventType.ERROR],
			batchInterval: 60,
			batchSize: 20,
		},
	],
})
```

The target sends its queue when the queue has 20 reports or when its oldest report has waited 60 seconds. If `batchInterval` is set and `batchSize` is not, the queue has no size limit. `batchInterval` works for `url` targets and for `sink` targets.

## Reference-level explanation

### New exports

| Export                                         | Kind  |
| ---------------------------------------------- | ----- |
| `CmcdEventSink`, `CmcdEventSinkResult`         | types |
| `CmcdEventSinkConfig`                          | type  |

### Types

```ts
type CmcdEventSinkResult = {
	readonly gone?: boolean
}

type CmcdEventSink = (reports: readonly DeepReadonly<Cmcd>[]) => Promise<CmcdEventSinkResult | void>

// An event target with a sink. The members other than the destination are those of CmcdEventReportConfig.
type CmcdEventSinkConfig = Omit<CmcdEventReportConfig, 'url' | 'transform'> & {
	sink: CmcdEventSink
}

// Changed members
type CmcdEventReportConfig<C> = {
	// ... the members of PR #486
	batchInterval?: number // new. seconds. default 0, which turns the time limit off
}

type CmcdSessionConfig = {
	// ... the members of PR #486
	eventTargets?: readonly (CmcdEventReportConfig | CmcdEventSinkConfig)[]
}
```

`CmcdEventSinkConfig` is a separate type, so `CmcdEventReportConfig` keeps `url` as a required member. Code that reads `url` from a `CmcdEventReportConfig` still compiles. `CmcdReporter` does not accept `CmcdEventSinkConfig`. `CmcdReporter` reads `batchInterval` only if maintainers want the feature in both APIs. See [Unresolved questions](#unresolved-questions).

The return type includes `void`, so an `async` sink without a `return` statement type-checks. The `DeepReadonly` type matches the type of `CmcdReportFilter` in PR #486.

### Destinations

A sink function is one destination, in the same way that a URL is one destination. Targets with the same sink function reference share one sequence number, one `msd` gate, and one set of waiting values. Two inline arrow functions are two destinations. A sink and a URL are never the same destination.

### Delivery

The delivery rules of PR #486 apply to a sink target without change:

- A target has at most one sink call in flight. Reports that arrive meanwhile wait in its queue.
- An `e` report in the queue makes the target send at once.
- After a rejection, the wait starts at 1 second and doubles after each failure, up to 60 seconds.
- `flush()` sends at once, also during a wait. `stop()` clears the wait timers.
- A `gone` result clears the queues and the waiting values of the destination. The session ignores the result of a call that is still in flight to that destination.

Each sink call receives its own copy of the reports. The copy shares no values with the data of the caller, with other targets, or with an earlier call. A sink that changes a report cannot change a retry.

### `batchInterval`

- The time limit of a queue counts from its oldest report.
- When the time limit ends, the target sends its queue in batches of at most `batchSize` reports. A report that remains keeps its own time limit.
- During a back-off wait, the time limit does not send. The retry takes the reports with it.
- `flush()` and a 410 or `gone` result cancel the time limit. `stop()` cancels the time limit, and `start()` arms it again.

### Configuration checks

The session adds these rules to its configuration checks. Each failure throws with the message format of PR #486.

| Parameter                     | Valid values                       |
| ----------------------------- | ---------------------------------- |
| `url` or `sink` of a target   | Exactly one of the two             |
| `sink` of a target            | A function                         |
| `batchInterval` of a target   | A finite number, 0 or more         |

Example message: `createCmcdSession: eventTargets[0] must have either url or sink, received both`.

## Prototype

The branch [`feat/cmcd-event-sink`](https://github.com/zshenker/common-media-library/tree/feat/cmcd-event-sink) of a fork implements the sink and `batchInterval` on `CmcdReporter`, because the session has no implementation yet. The prototype has 25 tests. An adversarial review found 9 issues. The branch fixes 7 issues in code and documents the other 2. The tests cover these cases:

- the copies of the reports for each target and each call,
- a time limit for each report, with batches of at most `batchSize`,
- a retry after a time limit,
- the timers of `stop()`, `start()`, and an evicted session,
- a time limit above the `setTimeout` limit,
- `gone` disposal that never stops a URL target.

The prototype follows the retry rule of `CmcdReporter`, not the back-off of PR #486. An implementation for the session follows the [Delivery](#delivery) rules of this RFC.

## Drawbacks

- **Copies.** A sink target copies each report when the report is queued and at each sink call. The `rr` event fires once per segment. URL targets do not copy.
- **One more timer.** A target with `batchInterval` has one `setTimeout` per partial queue.
- **One more type.** `CmcdEventSinkConfig` repeats the members of `CmcdEventReportConfig` through `Omit`. Version 3.0.0 can merge the two types when it reworks the configuration types.

## Rationale and alternatives

- **A union on `CmcdEventReportConfig`.** The prototype makes `url` optional in a union with `sink`. Code that reads `url` from the type then gets `string | undefined`. An `interface` can no longer extend the type. This change breaks the types of `CmcdReporter` adopters, so this RFC uses a separate type.
- **Decode in a custom `requester`.** This approach works with the session as specified. It encodes each report and decodes it again, and the player must invent HTTP status codes and a URL.
- **One sink on the session, next to `requester`.** A sink for each target keeps the destination next to its events, keys, and filter, as `url` does.
- **An option to remove `ts` from the report.** A sink receives `ts` as a separate key and can leave it out of the record data. An option would serve one transport only.
- **Encoded lines for the sink.** Most transports that are not HTTP need structured data. A sink that wants lines can call `encodeSfDict`.
- **Milliseconds for `batchInterval`.** The MSF draft uses milliseconds. `interval` uses seconds, so this RFC uses seconds for one rule in the package. The MSF layer converts the unit.

## Prior art

- CTA-5004-B defines event reports only as HTTP POST requests.
- `navigator.sendBeacon` and analytics SDKs commonly accept a transport function.
- The MSF draft defines `batchCount` and `batchInterval` with the "first limit wins" rule that this RFC adopts.

## Unresolved questions

1. **Meaning of `batchInterval`.** The MSF draft calls `batchInterval` the "minimum interval in milliseconds before publishing a new Group". This RFC reads it as the maximum wait of a report, because the draft also says that either limit triggers a Group. The draft example also says "sent once a minute". Review must confirm this reading with the draft authors.
2. **Timer limit.** `setTimeout` fires at once for a delay above 2,147,483 seconds. PR #486 decided against an upper limit for `interval`, and this RFC applies the same rule to `batchInterval`. Review can decide on one limit for both options.
3. **`CmcdReporter`.** PR #486 accepts only bug fixes for `CmcdReporter`. This RFC adds the sink to the session only. Review can decide whether `CmcdReporter` also gets `batchInterval`.
4. **Location of the MSF layer.** [Future possibilities](#future-possibilities) proposes a split between CML and the players.
5. **MSF version.** The CMCD draft cites MSF `-01`, but it depends on rules that only the MSF editor's copy contains. See [MSF version](#msf-version).

## Future possibilities

An MSF mapping layer can build on the sink. This RFC proposes to split the layer between CML and the players. The sink is the boundary between the two parts.

### Parts in CML

These parts are pure functions of the draft. They do no I/O and have no dependencies. Without them, every MoQ player implements the same rules again.

| Part                 | Behavior                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Configuration mapper | Converts a `publishTracks` entry with `cmcdConfig` into a `CmcdEventSinkConfig`. Converts milliseconds to seconds.           |
| Interval floor       | Raises an `interval` below 5000 milliseconds, as the security section of the draft asks.                                       |
| Key allowlist        | The 27 keys that the draft permits, as a `filter` or an `enabledKeys` list.                                                    |
| Event filter         | Rejects the `rr` and `h` events, which the draft forbids.                                                                      |
| Record serializer    | Converts a batch into a JSON array of `{ T, data }` records. Each value is a CMCD string that is not URL-encoded.              |
| Validation           | An MSF mode for `validateCmcdEventReport`.                                                                                      |

### Parts in the players

These parts need a MoQ session or the state of the catalog. CML has no MoQ transport, and a transport dependency would reach adopters who do not use MoQ.

- The MoQ session and the publication of the tracks, including a new connection when a track has a `connectionUri`.
- The parse of `publishTracks` from the catalog. The substitution of variables such as `%player-id%`, whose values come from the fragment of the catalog URI.
- The track tokens.
- The Group IDs, with the rules in [MSF version](#msf-version).
- The optional `MSF_COMPRESSION` property of the payload.

### Timing and location

The CMCD draft is an individual draft. This RFC proposes to add the CML parts only when the draft is stable. Until then, a guide shows a sink for MSF. The CML parts can start as a module of `@svta/cml-cmcd`. If several players parse MSF catalogs, a later `@svta/cml-msf` package can hold the catalog types and the CMCD mapping.

### MSF version

The CMCD draft cites `draft-ietf-moq-msf-01`. The [MSF editor's copy](https://github.com/moq-wg/msf) changed several rules after `-01`. The CMCD draft only works with the editor's copy:

| Rule                     | MSF `-01`                                                    | MSF editor's copy                                  | CMCD draft              |
| ------------------------ | ------------------------------------------------------------ | -------------------------------------------------- | ----------------------- |
| Wallclock index key      | `t`                                                          | `T`                                                | `T`                     |
| Records in each Group    | The first Object of each Group holds every record up to then | Defined by the event type                          | One record or one batch |
| Event track requirements | `depends` and `mimetype` are required                        | `depends` only for an index on a Media Timeline    | Neither field           |
| Track properties         | None for Event Timeline                                      | `MSF_EVENT_TIMELINE_HEADER` carries invariant data | Not used                |

MSF `-00` has no `publishTracks`, so it cannot carry CMCD. The CML parts must name the MSF version that they implement.

The MSF Group numbering rule (section 6.1 in `-01` and the editor's copy) conflicts with the CMCD draft. MSF requires Group IDs that increase on a track, also after a publisher restarts. The CMCD draft says that the Group ID begins at 0 for each session. A player that reloads and publishes on the same track again breaks the MSF rule. The player must follow the MSF rule. One method from MSF is a first Group ID from the wallclock time in milliseconds.

The CMCD draft has these issues, which the authors must resolve before the record serializer is final:

- The text says that every value is a string. The example uses numbers, such as `"bl": 4068` and `"v": 2`.
- The play-state example lists `ps` in `enabledKeys`. `ps` is an event. The play-state key is `sta`.
- `interval` is optional and has no default value. The session default is 30 seconds.
- `cmcdConfig` allows one `sid` for each track. A session has one `sid`, so tracks with different `sid` values need separate sessions.
- The example shows one record. An MSF Event Timeline payload is a JSON array of records.
- Keys that do not change in a session, such as `v`, `sid`, and `cid`, could go in the `MSF_EVENT_TIMELINE_HEADER` property once.
- The MSF registry experts require that a `urn:` type follows RFC 8141. This RFC did not confirm that `cta` is a registered URN namespace for `urn:cta:cmcd:2026`.
- [Issue #3](https://github.com/wilaw/CMCD-over-MSF-event-timeline/issues/3) proposes an `L` index that ties a report to a media track. The record serializer then needs the Location index as well as `T`.
- [Issue #4](https://github.com/wilaw/CMCD-over-MSF-event-timeline/issues/4) notes that `enabledKeys` excludes custom keys. A custom event (`ce`) then cannot carry its value. The key allowlist depends on the answer.

## Final Decision

Pending review.
