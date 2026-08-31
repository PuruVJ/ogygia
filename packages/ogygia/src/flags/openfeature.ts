/**
 * `ogygia/flag/openfeature` — bridge an OpenFeature client into ogygia's flag decision seam.
 *
 * The app already creates its own OpenFeature client (any provider — LaunchDarkly, Flagsmith,
 * Unleash, flagd, …); ogygia depends on NO vendor SDK. This adapter is pure structural typing:
 * it hands the client one bulk evaluation per request over exactly the flags the app declares,
 * and returns their decisions. After that one await, an OpenFeature-decided flag is
 * indistinguishable from a native one — same sync reads, same `pick()`, same federation carry.
 *
 *   import { OpenFeature } from '@openfeature/server-sdk';
 *   import { decide } from 'ogygia/flag';
 *   import { openfeature } from 'ogygia/flag/openfeature';
 *   decide({ source: openfeature(OpenFeature.getClient()) });
 */
import type { FlagSource, FlagQuery, Resolved, CtxLike } from '../flags.js';

export { ofrep, type OfrepOptions } from './ofrep.js';

/** The slice of the OpenFeature server `Client` we use — structural, so any SDK version fits. */
export interface OpenFeatureClientLike {
	getBooleanValue(
		flagKey: string,
		defaultValue: boolean,
		context?: EvaluationContextLike
	): Promise<boolean>;
	getStringValue(
		flagKey: string,
		defaultValue: string,
		context?: EvaluationContextLike
	): Promise<string>;
	/** Optional: variants that carry a config payload read via `.value(c)`. */
	getObjectValue?<T>(flagKey: string, defaultValue: T, context?: EvaluationContextLike): Promise<T>;
}

export interface EvaluationContextLike {
	targetingKey?: string;
	[k: string]: unknown;
}

export interface OpenFeatureOptions {
	/** Build the OpenFeature evaluation context from the request (default: visitor `sub` →
	 *  `targetingKey`, plus every own key of `c.visitor`). */
	context?: (c: CtxLike) => EvaluationContextLike;
	/** Also pull each flag's object value as the `.value(c)` payload (one extra eval per flag).
	 *  Off by default — most flags are variant-only. */
	values?: boolean;
}

function default_context(c: CtxLike): EvaluationContextLike {
	const sub = c.visitor?.sub;
	return { ...(c.visitor ?? {}), ...(sub ? { targetingKey: sub } : {}) };
}

export function openfeature(
	client: OpenFeatureClientLike,
	opts: OpenFeatureOptions = {}
): FlagSource {
	const ctx_of = opts.context ?? default_context;
	return async (queries: FlagQuery[], c: CtxLike): Promise<Record<string, Resolved>> => {
		const context = ctx_of(c);
		const out: Record<string, Resolved> = {};
		await Promise.all(
			queries.map(async (q) => {
				try {
					if (q.kind === 'boolean') {
						// default OFF — a missing key must never silently enable a feature.
						const on = await client.getBooleanValue(q.name, false, context);
						out[q.name] = on ? 'on' : 'off';
					} else {
						// variant flag: the string value IS the variant name (control default).
						const variant = await client.getStringValue(q.name, q.variants[0], context);
						out[q.name] = variant;
					}
					if (opts.values && client.getObjectValue) {
						const value = await client.getObjectValue(q.name, undefined, context);
						if (value !== undefined) {
							const prev = out[q.name];
							out[q.name] = {
								variant: typeof prev === 'string' ? prev : q.variants[0],
								value
							};
						}
					}
				} catch {
					/* one flag's eval failure falls through to the native rule, not the whole request */
				}
			})
		);
		return out;
	};
}
