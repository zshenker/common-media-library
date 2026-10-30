---
status: draft
---

# RFC: Event sinks and time-based batching in `CmcdReporter`

|                     |                                                         |
| ------------------- | ------------------------------------------------------- |
| **Author**          | Zac Shenker                                             |
| **Date**            | 2026-10-29                                              |
| **Package**         | `@svta/cml-cmcd`                                        |
| **Breaking change** | No at runtime. `CmcdEventReportConfig` becomes a union type, see [Drawbacks](#drawbacks). |

## Summary

`CmcdReporter` sends event reports only as HTTP POST requests to a collector URL. This RFC adds two options to an event target:

- `sink`: a function that receives each batch as prepared CMCD data. A target has either a `url` or a `sink`.
- `batchInterval`: the maximum time in seconds that a report waits in a batch.

```ts
import { CmcdEventType, CmcdReporter } from '@svta/cml-cmcd'
import type { CmcdEventSink } from '@svta/cml-cmcd'

declare function publishRecord(record: { T: number; data: object }): Promise<void>

const sink: CmcdEventSink = async reports => {
	for (const { ts, ...data } of reports) {
		await publishRecord({ T: ts as number, data })
	}
}

const reporter = new CmcdReporter({
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

## Motivation

The individual draft [CMCD over MSF Event Timeline](https://wilaw.github.io/CMCD-over-MSF-event-timeline/draft-wilaw-moq-cmcd-event-timeline.html) defines how a player sends CMCD v2 event reports over Media over QUIC (MoQ). The MSF catalog lists CMCD tracks in `publishTracks`. The player publishes one Event Timeline record per report. The draft has these requirements for the reporter:

1. Reports go to a MoQ track, not to an HTTP URL.
2. The value of `ts` becomes the `T` time index of the record and is not part of the record data.
3. A Group of records is published when it reaches `batchCount` records or when `batchInterval` ends, whichever happens first.

The reporter cannot meet these requirements today:

- The constructor accepts a custom `requester`, but the requester receives an `HttpRequest` with the encoded text body. A MoQ player must decode every line again and must return fake HTTP status codes to control retries.
- `url` is required, and a MoQ target has a namespace and a track name, not a URL.
- Batching is by count only.

The same gaps apply to other transports that are not HTTP, such as WebSocket. A sink keeps the reporter's session logic, `sn` sequence, `msd` gate, transforms, and retry queue for every transport.

## Guide-level explanation

### Send reports to a sink

Give the event target a `sink` instead of a `url`. The reporter calls the sink with each batch.

Each report is the prepared CMCD data of one event, in the form that `prepareCmcdData` returns. The reporter has already applied `enabledKeys`, the `transform`, and the session keys `sid`, `sn`, and `msd`. Every report contains `e`, `ts`, and `v`. Values are in their prepared form. A token is an `SfToken`, an inner list is an array, and numbers are rounded as the key requires. Each call receives its own copy of the reports.

The promise of the sink controls what the reporter does next:

| Sink result                    | Reporter action                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Resolves                       | The batch is delivered.                                                         |
| Resolves with `{ gone: true }` | Stops reporting to every target with the same sink for the rest of the session. |
| Rejects or throws              | Queues the batch again. See [Sink semantics](#sink-semantics).                  |

### Batch by time

```ts
import { CmcdEventType, CmcdReporter } from '@svta/cml-cmcd'

const reporter = new CmcdReporter({
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

The reporter sends the batch when it has 20 reports or when its oldest report has waited 60 seconds. If `batchInterval` is set and `batchSize` is not, the batch has no size limit.

## Reference-level explanation

### Types

```ts
type CmcdEventSinkResult = {
	readonly gone?: boolean
}

type CmcdEventSink = (reports: readonly Readonly<Cmcd>[]) => Promise<CmcdEventSinkResult | void>

type CmcdEventReportDestination =
	| { url: string; sink?: undefined }
	| { url?: undefined; sink: CmcdEventSink }

type CmcdEventReportConfig<C> = CmcdReportConfig &
	CmcdEventReportDestination & {
		version?: typeof CMCD_V2
		events?: CmcdEventType[]
		interval?: number
		batchSize?: number
		batchInterval?: number
		transform?: CmcdEventReportTransform<C>
	}
```

The return type includes `void`. An `async` sink without a `return` statement, or with a `return` on some paths only, therefore type-checks.

### Sink semantics

- **Queue.** The reporter prepares and encodes each report at queue time, for HTTP targets and sink targets. A report that cannot serialize throws inside the recording call, as before. A URL target keeps only the encoded line. A sink target keeps only the prepared data.
- **Isolation.** A sink target copies the prepared data at queue time, because the data shares nested values with the data store and with other targets. Each sink call receives another copy. A sink that mutates a report changes neither the reporter state nor a retry.
- **Retry.** A rejected promise or a synchronous throw from the sink queues the batch again at the front of the queue. A target with a `batchInterval` sends the batch again after one interval. Other targets send it with their next batch or on `flush()`. HTTP 429 and 5xx responses follow the same rules. The reporter never drops a rejected batch, so a sink resolves to drop a batch that can never succeed.
- **Order.** A retry can merge a failed batch with later reports, and it can arrive after a batch that was sent later. A sink orders reports by `sn`, and it assigns transport sequence numbers when it publishes.
- **Disposal.** `{ gone: true }` disposes every target of the session that has the same sink function reference. Each MoQ track therefore needs its own sink function. An HTTP 410 response never disposes a sink target, and a sink result never disposes an HTTP target.
- **Precedence.** The types forbid a target with both `url` and `sink`. At runtime, the reporter uses `sink` if both are present. A target with neither is ignored, like a target without `events`.

### `batchInterval` semantics

- The unit is seconds, the same as `interval`.
- The time limit of a batch counts from its oldest report.
- When the time limit ends, the reporter sends the queue in batches of at most `batchSize` reports. A report that remains keeps its own time limit.
- A value that is not a positive number disables the time limit. A value above 2,147,483 seconds is reduced to that limit, because `setTimeout` fires at once for a larger delay.
- `flush()`, a 410 or `gone` disposal, and the drain of an ended session cancel the time limit. The timer of an evicted session never fires a send.
- `stop()` cancels the time limits. The queued reports wait for `flush()`, for `start()`, or for a batch that reaches `batchSize`. `start()` arms the time limits again.

### What this RFC does not change

- The HTTP wire format and the `requester` contract.
- The CTA-5004-B rules for `sn`, `msd`, and session changes.
- Request mode.

## Drawbacks

- **Type change.** `CmcdEventReportConfig` becomes a union. Code that creates configurations is not affected. Three patterns no longer compile, and the changelog gives the migration of each:
  - A read of `url` gets `string | undefined`.
  - An `interface` cannot extend the type.
  - `Omit` and `Partial` keep the `sink` member, so a spread with a new `url` fails.
- **Copies.** A sink target copies each report at queue time and at each sink call. The `rr` event fires once per segment, so a sink target for `rr` copies a report per segment. URL targets do not copy.
- **One more timer.** A target with `batchInterval` has one `setTimeout` per partial batch.

## Rationale and alternatives

- **Decode in a custom `requester`.** This approach works today without changes. It encodes each report and then decodes it again. It ties retries to fake HTTP status codes, and it needs a fake URL. This RFC rejects it as the recommended path.
- **One sink on the reporter, next to `requester`.** A reporter-level sink would need the target configuration to choose a destination. A per-target sink keeps the destination next to its events and keys, which is how `url` works.
- **An option to remove `ts` from the report.** A sink receives `ts` as a separate key and can leave it out of the record data. An extra option would only serve one transport.
- **Pass encoded lines to the sink.** Most transports that are not HTTP need structured data. A sink that wants lines can call `encodeSfDict` from `@svta/cml-structured-field-values`.
- **Milliseconds for `batchInterval`.** The MSF draft uses milliseconds. `interval` uses seconds, so this RFC uses seconds for consistency in the package. The MSF layer converts the unit.

## Prior art

- CTA-5004-B defines event reports only as HTTP POST requests.
- `navigator.sendBeacon` and analytics SDKs commonly accept a pluggable transport function.
- The MSF draft defines `batchCount` and `batchInterval` with the "first limit wins" rule that this RFC adopts.

## Unresolved questions

1. **Meaning of `batchInterval`.** The MSF draft calls `batchInterval` the "minimum milliseconds before a new Group". This RFC reads it as the maximum wait of a batch, because the draft also says that either limit triggers a Group. Review must confirm this reading with the draft authors.
2. **Scope of `gone`.** This RFC scopes `gone` to the sink function. An alternative is to scope it to the target only.
3. **Location of the MSF layer.** [Future possibilities](#future-possibilities) proposes a split between CML and the players. Review must confirm the split.
4. **MSF version.** The CMCD draft cites MSF `-01`, but it depends on rules that only the MSF editor's copy contains. See [MSF version](#msf-version).

## Future possibilities

An MSF mapping layer can build on the sink. This RFC proposes to split the layer between CML and the players. The sink is the boundary between the two parts.

### Parts in CML

These parts are pure functions of the draft. They do no I/O and have no dependencies. Without them, every MoQ player implements the same rules again.

| Part                 | Behavior                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Configuration mapper | Converts a `publishTracks` entry with `cmcdConfig` into a `CmcdEventReportConfig`. Converts milliseconds to seconds. |
| Interval floor       | Raises an `interval` below 5000 milliseconds, as the security section of the draft asks.                              |
| Key allowlist        | The 27 keys that the draft permits. A transform removes all other keys.                                                |
| Event filter         | Rejects the `rr` and `h` events, which the draft forbids.                                                              |
| Record serializer    | Converts a batch into a JSON array of `{ T, data }` records. Each value is a CMCD string that is not URL-encoded.      |
| Validation           | An MSF mode for `validateCmcdEventReport`.                                                                             |

### Parts in the players

These parts need a MoQ session or the state of the catalog. CML has no MoQ transport, and a transport dependency would reach adopters who do not use MoQ.

- The MoQ session and the publication of the tracks, including a new connection when a track has a `connectionUri`.
- The parse of `publishTracks` from the catalog. The substitution of variables such as `%player-id%`, whose values come from the fragment of the catalog URI.
- The track tokens.
- The Group IDs, with the rules in [MSF version](#msf-version).
- The optional `MSF_COMPRESSION` property of the payload.

### Timing and location

The draft is an individual draft. This RFC proposes to add the CML parts only when the draft is stable. Until then, a guide shows a sink for MSF. The CML parts can start as a module of `@svta/cml-cmcd`. If several players parse MSF catalogs, a later `@svta/cml-msf` package can hold the catalog types and the CMCD mapping.

### MSF version

The CMCD draft cites `draft-ietf-moq-msf-01`. The [MSF editor's copy](https://github.com/moq-wg/msf) changed several rules after `-01`. The CMCD draft only works with the editor's copy:

| Rule                     | MSF `-01`                                                    | MSF editor's copy                                   | CMCD draft                    |
| ------------------------ | ------------------------------------------------------------ | --------------------------------------------------- | ----------------------------- |
| Wallclock index key      | `t`                                                          | `T`                                                 | `T`                           |
| Records in each Group    | The first Object of each Group holds every record up to then | Defined by the event type                           | One record or one batch       |
| Event track requirements | `depends` and `mimetype` are required                        | `depends` only for an index on a Media Timeline     | Neither field                 |
| Track properties         | None for Event Timeline                                      | `MSF_EVENT_TIMELINE_HEADER` carries invariant data  | Not used                      |

MSF `-00` has no `publishTracks`, so it cannot carry CMCD. The CML parts must name the MSF version that they implement.

The MSF Group numbering rule (section 6.1 in `-01` and the editor's copy) conflicts with the CMCD draft. MSF requires Group IDs that increase on a track, also after a publisher restarts. The CMCD draft says that the Group ID begins at 0 for each session. A player that reloads and publishes on the same track again breaks the MSF rule. The player must follow the MSF rule. One method from MSF is a first Group ID from the wallclock time in milliseconds.

The CMCD draft has these issues, which the authors must resolve before the record serializer is final:

- The text says that every value is a string. The example uses numbers, such as `"bl": 4068` and `"v": 2`.
- The play-state example lists `ps` in `enabledKeys`. `ps` is an event. The play-state key is `sta`.
- `interval` is optional and has no default value. The reporter default is 30 seconds.
- `cmcdConfig` allows one `sid` for each track. `CmcdReporter` has one `sid` for each reporter, so tracks with different `sid` values need separate reporters.
- The example shows one record. An MSF Event Timeline payload is a JSON array of records.
- Keys that do not change in a session, such as `v`, `sid`, and `cid`, could go in the `MSF_EVENT_TIMELINE_HEADER` property once.
- The MSF registry experts require that a `urn:` type follows RFC 8141. This RFC did not confirm that `cta` is a registered URN namespace for `urn:cta:cmcd:2026`.
- [Issue #3](https://github.com/wilaw/CMCD-over-MSF-event-timeline/issues/3) proposes an `L` index that ties a report to a media track. The record serializer then needs the Location index as well as `T`.
- [Issue #4](https://github.com/wilaw/CMCD-over-MSF-event-timeline/issues/4) notes that `enabledKeys` excludes custom keys. A custom event (`ce`) then cannot carry its value. The key allowlist depends on the answer.

## Final Decision

Pending review.
