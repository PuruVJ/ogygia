/**
 * `ogygia/openfeature` (OFREP) — speak the OpenFeature Remote Evaluation Protocol directly, with
 * ZERO vendor SDK. Any OFREP endpoint works (flagd, the OpenFeature operator, a gateway). One
 * bulk POST per request over the app's declared flags; decisions come back as variant names +
 * optional payloads, indistinguishable from native flags after the await.
 *
 *   import { decide } from 'ogygia';
 *   import { ofrep } from 'ogygia/openfeature';
 *   decide({ source: ofrep({ url: 'http://flagd:8016' }) });
 */
import type { FlagSource, FlagQuery, Resolved, CtxLike } from '../flags.js';

export interface OfrepOptions {
	/** OFREP base URL (the adapter calls `<url>/ofrep/v1/evaluate/flags/bulk`). */
	url: string;
	/** Static headers (auth token, tenant) sent with every evaluation. */
	headers?: Record<string, string>;
	/** Build the OFREP evaluation context from the request (default: visitor `sub` →
	 *  `targetingKey` plus every own key of `c.visitor`). */
	context?: (c: CtxLike) => Record<string, unknown>;
	/** Per-request fetch (default global). */
	fetch?: typeof fetch;
	/** Abort the evaluation after N ms (default 800 — a flag service must not gate first byte). */
	timeout?: number;
}

interface OfrepFlag {
	key: string;
	variant?: string;
	value?: unknown;
	reason?: string;
	errorCode?: string;
}

function default_context(c: CtxLike): Record<string, unknown> {
	const sub = c.visitor?.sub;
	return { ...(c.visitor ?? {}), ...(sub ? { targetingKey: sub } : {}) };
}

export function ofrep(opts: OfrepOptions): FlagSource {
	const ctx_of = opts.context ?? default_context;
	const f = opts.fetch ?? fetch;
	const endpoint = opts.url.replace(/\/$/, '') + '/ofrep/v1/evaluate/flags/bulk';
	const timeout = opts.timeout ?? 800;
	return async (queries: FlagQuery[], c: CtxLike): Promise<Record<string, Resolved>> => {
		const out: Record<string, Resolved> = {};
		try {
			const res = await f(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
				body: JSON.stringify({ context: ctx_of(c) }),
				signal: AbortSignal.timeout(timeout)
			});
			if (!res.ok) return out; // whole endpoint down → all native
			const body = (await res.json()) as { flags?: OfrepFlag[] };
			const want = new Map(queries.map((q) => [q.name, q]));
			for (const f of body.flags ?? []) {
				const q = want.get(f.key);
				if (!q || f.errorCode) continue;
				// boolean flags: OFREP returns a boolean value; variant flags: a variant name.
				const variant =
					f.variant ?? (typeof f.value === 'boolean' ? (f.value ? 'on' : 'off') : undefined);
				if (variant === undefined || !q.variants.includes(variant)) continue;
				out[f.key] =
					f.value !== undefined && typeof f.value !== 'boolean'
						? { variant, value: f.value }
						: variant;
			}
		} catch {
			/* timeout / network → everything falls through to the native rule */
		}
		return out;
	};
}
