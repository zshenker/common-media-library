---
status: draft
---

# RFC: Event sinks and time-based batching in `CmcdReporter`

|                     |                                                         |
| ------------------- | ------------------------------------------------------- |
| **Author**          | Zac Shenker                                             |
| **Date**            | 2026-10-29                                              |
| **Package**         | `@svta/cml-cmcd`                                        |
| **Breaking change** | No at runtime. One type change, see [Drawbacks](#drawbacks). |

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

The IETF draft [CMCD over MSF Event Timeline](https://wilaw.github.io/CMCD-over-MSF-event-timeline/draft-wilaw-moq-cmcd-event-timeline.html) defines how a player sends CMCD v2 event reports over Media over QUIC (MoQ). The MSF catalog lists CMCD tracks in `publishTracks`. The player publishes one Event Timeline record per report. The draft has these requirements for the reporter:

1. Reports go to a MoQ track, not to an HTTP URL.
2. The `ts` value moves out of the report into the `T` time index of the record.
3. A Group of records is published when it reaches `batchCount` records or when `batchInterval` ends, whichever happens first.

The reporter cannot meet these requirements today:

- The constructor accepts a custom `requester`, but the requester receives an `HttpRequest` with the encoded text body. A MoQ player must decode every line again and must return fake HTTP status codes to control retries.
- `url` is required, and a MoQ target has a namespace and a track name, not a URL.
- Batching is by count only.

The same gaps apply to other transports that are not HTTP, such as WebSocket. A sink keeps the reporter's session logic, `sn` sequence, `msd` gate, transforms, and retry queue for every transport.

## Guide-level explanation

### Send reports to a sink

Give the event target a `sink` instead of a `url`. The reporter calls the sink with each batch.

Each report is the prepared CMCD data of one event, in the form that `prepareCmcdData` returns. The reporter has already applied `enabledKeys`, the `transform`, and the session keys `sid`, `sn`, and `msd`. Every report contains `e`, `ts`, and `v`. Values are in their prepared form. A token is an `SfToken`, an inner list is an array, and numbers are rounded as the key requires.

The promise of the sink controls what the reporter does next:

| Sink result                    | Reporter action                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Resolves                       | The batch is delivered.                                                         |
| Resolves with `{ gone: true }` | Stops reporting to every target with the same sink for the rest of the session. |
| Rejects or throws              | Queues the batch again and sends it on the next queue pass.                     |

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

The reporter sends the batch when it has 20 reports or when its first report has waited 60 seconds. If `batchInterval` is set and `batchSize` is not, the batch has no size limit.

## Reference-level explanation

### Types

```ts
type CmcdEventSinkResult = {
	readonly gone?: boolean
}

type CmcdEventSink = (reports: readonly Cmcd[]) => Promise<CmcdEventSinkResult | void>

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

- **Queue.** The reporter prepares and encodes each report at queue time, for HTTP targets and sink targets. A report that cannot serialize throws inside the recording call, as before. The sink therefore receives only data that serializes.
- **Retry.** A rejected promise or a synchronous throw from the sink queues the batch again at the front of the queue. The batch is sent on the next queue pass. This rule is the same as for HTTP 429 and 5xx responses.
- **Disposal.** `{ gone: true }` disposes every target of the session that has the same sink function. Each MoQ track therefore needs its own sink function. An HTTP 410 response never disposes a sink target, and a sink result never disposes an HTTP target.
- **Precedence.** The types forbid a target with both `url` and `sink`. At runtime, the reporter uses `sink` if both are present. A target with neither is ignored, like a target without `events`.
- **Mutation.** The sink must not mutate the reports, because a failed batch is sent again.

### `batchInterval` semantics

- The unit is seconds, the same as `interval`.
- The time starts when the first report enters an empty queue.
- A send at `batchSize` cancels the time limit. The next report starts a new time limit.
- A value that is not a positive number disables the time limit.
- `flush()`, a 410 or `gone` disposal, and the drain of an ended session cancel the time limit.
- `stop()` without `flush` does not cancel the time limit. The batch is sent when the time ends. `stop()` only stops the time-interval events, and the reporter already sends explicit events after `stop()`.

### What this RFC does not change

- The HTTP wire format and the `requester` contract.
- The CTA-5004-B rules for `sn`, `msd`, and session changes.
- Request mode.

## Drawbacks

- **Type change.** `url` becomes optional in `CmcdEventReportConfig`. Code that creates configurations is not affected. Code that reads `url` from a `CmcdEventReportConfig` value gets `string | undefined` and must narrow it. The changelog states the migration.
- **Memory.** Each queued report keeps its prepared data and its encoded line. Event reports are rare compared with segment requests, so the cost is small.
- **One more timer.** A target with `batchInterval` has one `setTimeout` per partial batch.

## Rationale and alternatives

- **Decode in a custom `requester`.** This approach works today without changes. It encodes each report and then decodes it again. It ties retries to fake HTTP status codes, and it needs a fake URL. This RFC rejects it as the recommended path.
- **One sink on the reporter, next to `requester`.** A reporter-level sink would need the target configuration to choose a destination. A per-target sink keeps the destination next to its events and keys, which is how `url` works.
- **An option to remove `ts` from the report.** A sink receives `ts` as a separate key and can move it. An extra option would only serve one transport.
- **Pass encoded lines to the sink.** Most transports that are not HTTP need structured data. A sink that wants lines can call `encodeSfDict` from `@svta/cml-structured-field-values`.
- **Milliseconds for `batchInterval`.** The MSF draft uses milliseconds. `interval` uses seconds, so this RFC uses seconds for consistency in the package. The MSF layer converts the unit.

## Prior art

- CTA-5004-B defines event reports only as HTTP POST requests.
- `navigator.sendBeacon` and analytics SDKs commonly accept a pluggable transport function.
- The MSF draft defines `batchCount` and `batchInterval` with the "first limit wins" rule that this RFC adopts.

## Unresolved questions

1. **Meaning of `batchInterval`.** The MSF draft calls `batchInterval` the "minimum milliseconds before a new Group". This RFC reads it as the maximum wait of a batch, because the draft also says that either limit triggers a Group. Review must confirm this reading with the draft authors.
2. **Scope of `gone`.** This RFC scopes `gone` to the sink function. An alternative is to scope it to the target only.
3. **Package for the MSF layer.** See [Future possibilities](#future-possibilities).

## Future possibilities

An MSF mapping layer can build on the sink. Review should decide whether the layer is a new package, a module of `@svta/cml-cmcd`, or a guide. The draft is an individual draft, so this RFC proposes to wait until the draft is stable. The layer needs these parts:

| Part                       | Behavior                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Configuration mapper       | Converts a `publishTracks` entry with `cmcdConfig` into a `CmcdEventReportConfig`. Converts milliseconds to seconds. |
| Interval floor             | Raises an `interval` below 5000 milliseconds, as the security section of the draft asks.                              |
| Key allowlist              | The 27 keys that the draft permits. A transform removes all other keys.                                                |
| Event filter               | Rejects the `rr` and `h` events, which the draft forbids.                                                              |
| Record serializer          | Converts a prepared report into `{ T, data }`, with the value of each key as a CMCD string that is not URL-encoded.   |
| Group counter              | Starts at 0 for each session and increments by one for each batch.                                                    |
| Validation                 | An MSF mode for `validateCmcdEventReport`.                                                                             |

The draft has these inconsistencies, which the authors must resolve before the record serializer is final:

- The text says that every value is a string. The example uses numbers, such as `"bl": 4068` and `"v": 2`.
- The play-state example lists `ps` in `enabledKeys`. `ps` is an event. The play-state key is `sta`.
- `interval` is optional and has no default value. The reporter default is 30 seconds.
- `cmcdConfig` allows one `sid` for each track. `CmcdReporter` has one `sid` for each reporter, so tracks with different `sid` values need separate reporters.

## Final Decision

Pending review.
