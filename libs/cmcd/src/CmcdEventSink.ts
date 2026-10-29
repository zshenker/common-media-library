import type { Cmcd } from './Cmcd.ts'

/**
 * The result of a {@link CmcdEventSink} delivery.
 *
 * @public
 */
export type CmcdEventSinkResult = {
	/**
	 * If `true`, the destination no longer accepts reports. The reporter
	 * stops reporting to every target that uses the same sink for the rest
	 * of the session. This flag has the same effect as an HTTP 410 response
	 * from a collector URL.
	 * @defaultValue `false`
	 */
	readonly gone?: boolean
}

/**
 * Delivers a batch of CMCD event reports to a destination that is not an
 * HTTP collector, for example a Media over QUIC track.
 *
 * Each report is the prepared CMCD data of one event, in the same form that
 * {@link prepareCmcdData} returns. The reporter has already applied the
 * target's `enabledKeys`, the `transform`, and the session keys (`sid`,
 * `sn`, `msd`). Every report contains `e`, `ts`, and `v`. The reporter
 * checks at queue time that each report serializes, so the sink can
 * serialize every value.
 *
 * Resolve to report a delivery. Resolve with `{ gone: true }` to stop
 * reporting to this sink for the rest of the session. Reject to report a
 * temporary failure. The reporter then queues the batch again and sends it
 * on the next queue pass. The sink must not mutate the reports, because a
 * failed batch is sent again.
 *
 * @param reports - The event reports of the batch, oldest first.
 * @returns A promise that settles when the delivery completes.
 *
 * @example
 * {@includeCode ../test/CmcdReporter.test.ts#example-sink}
 *
 * @public
 */
// The sink is a callback that the adopter writes. `void` lets an async sink
// without a return statement, or with a return on some paths only, match.
// oxlint-disable-next-line typescript/no-invalid-void-type
export type CmcdEventSink = (reports: readonly Cmcd[]) => Promise<CmcdEventSinkResult | void>
