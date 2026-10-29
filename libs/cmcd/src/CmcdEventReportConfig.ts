import type { CMCD_V2 } from './CMCD_V2.ts'
import type { CmcdEventReportTransform } from './CmcdEventReportTransform.ts'
import type { CmcdEventSink } from './CmcdEventSink.ts'
import type { CmcdEventType } from './CmcdEventType.ts'
import type { CmcdReportConfig } from './CmcdReportConfig.ts'

/**
 * The destination of a CMCD event target. A target has either a collector
 * `url` or a `sink`, never both.
 *
 * @public
 */
export type CmcdEventReportDestination =
	| {
			/**
			 * The URL where the reporter sends CMCD event reports as HTTP POST
			 * requests.
			 */
			url: string

			/**
			 * Not allowed together with `url`.
			 */
			sink?: undefined
	  }
	| {
			/**
			 * Not allowed together with `sink`.
			 */
			url?: undefined

			/**
			 * The function that delivers CMCD event reports to a destination
			 * that is not an HTTP collector. Use a sink for transports such as
			 * Media over QUIC.
			 *
			 * @see {@link CmcdEventSink}
			 */
			sink: CmcdEventSink
	  }

/**
 * Configuration for a CMCD event report.
 *
 * @typeParam C - The type of the player's `customData` on the request that
 *                triggered the event. Defaults to `Record<string, unknown>`.
 *
 * @public
 */
export type CmcdEventReportConfig<C = Record<string, unknown>> = CmcdReportConfig &
	CmcdEventReportDestination & {
		/**
		 * The version of the CMCD protocol to use. Event reporting
		 * requires version 2.
		 *
		 * @defaultValue `CMCD_V2`
		 */
		version?: typeof CMCD_V2

		/**
		 * The events to report. If the caller provides no events,
		 * the event target is effectively disabled.
		 *
		 * @defaultValue `undefined`
		 */
		events?: CmcdEventType[]

		/**
		 * When the time interval event is sent, the interval in seconds at
		 * which the reporter sends it.
		 *
		 * @defaultValue `CMCD_DEFAULT_TIME_INTERVAL`
		 *
		 * @see {@link CMCD_DEFAULT_TIME_INTERVAL}
		 */
		interval?: number

		/**
		 * The number of events to batch before sending the report.
		 *
		 * If `batchInterval` is set and `batchSize` is not, the batch has no
		 * size limit.
		 *
		 * @defaultValue `1`
		 */
		batchSize?: number

		/**
		 * The maximum time in seconds that a report waits in a batch. The
		 * time starts when the first report of the batch is queued. The
		 * reporter sends the batch when it reaches `batchSize` or when this
		 * time ends, whichever happens first. `0` disables the time limit.
		 *
		 * @defaultValue `0`
		 */
		batchInterval?: number

		/**
		 * Transform applied to each of this target's event reports before
		 * it is queued. Return the data to continue, or `null` to cancel
		 * the report for this target.
		 *
		 * The transform is scoped to this target only. Targets that share a
		 * collector URL each run their own transform. Other targets that
		 * accept the event still receive a report cancelled by this transform.
		 *
		 * @defaultValue `undefined`
		 *
		 * @example
		 * {@includeCode ../test/CmcdReporter.test.ts#example-transform}
		 */
		transform?: CmcdEventReportTransform<C>
	}
