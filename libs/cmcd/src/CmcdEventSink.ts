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
 * `sn`, `msd`). Every report contains `e`, `ts`, and `v`. A token value is
 * an `SfToken` instance, and an inner list is an array. The reporter checks
 * at queue time that each report serializes with `encodeSfDict` from
 * `@svta/cml-structured-field-values`.
 *
 * Each call receives its own copy of the reports. The copy shares no values
 * with the reporter, with other targets, or with an earlier call.
 *
 * The promise controls what the reporter does next:
 *
 * - Resolve to report a delivery. Also resolve to drop a batch that can
 *   never succeed, because a rejected batch is sent again.
 *
 * - Resolve with `{ gone: true }` to stop reporting to this sink for the rest
 *   of the session. The rule applies to every target with the same function
 *   reference. Give each destination its own function.
 *
 * - Reject to report a temporary failure. The reporter queues the batch
 *   again. A target with a `batchInterval` sends it again after one interval.
 *   Other targets send it with the next batch or with `flush()`.
 *
 * A retry can merge a failed batch with later reports, and it can follow a
 * batch that was sent later. Use `sn` to order the reports and to detect
 * duplicates. Assign transport sequence numbers, such as MOQT Group IDs, when
 * the sink publishes, not from the report content.
 *
 * @param reports - The event reports of the batch, oldest first.
 * @returns A promise that settles when the delivery completes.
 *
 * @example
 * {@includeCode ../test/CmcdReporter.test.ts#example-sink}
 *
 * @public
 */
export type CmcdEventSink = (
	reports: readonly Readonly<Cmcd>[],
	// The sink is a callback that the adopter writes. `void` lets an async sink
	// without a return statement, or with a return on some paths only, match.
	// oxlint-disable-next-line typescript/no-invalid-void-type
) => Promise<CmcdEventSinkResult | void>
