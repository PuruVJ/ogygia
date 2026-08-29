/**
 * The typed API client — `$infer` for ENDPOINTS, consumed. The table already knows every
 * endpoint's path grammar, body schema, and (for PLAIN returns, which `finalize()` serializes
 * to JSON) its payload type; `api<App>()` hands all of that to the caller as a fetch client:
 *
 *     export type App = typeof app.$infer;               // the one map the app already exports
 *     const cms = api<App>('https://cms.internal');
 *     const post = await cms.get('/posts/[id]', { params: { id: '1' } });  // out: typed
 *     await cms.post('/api/[id]', { params: { id }, body });               // body: schema-typed
 *
 * Paths are constrained to keys that HAVE the verb (page paths never carry one, so they are
 * excluded for free); `params` is required exactly when the pattern has any; a handler that
 * returned a raw `Response` types as `unknown` (its payload is inside the Response — write
 * plain returns for typed endpoints). Non-2xx answers throw {@link ApiError} carrying the
 * status and the parsed error body.
 *
 * BROWSER-SAFE by construction: this module imports only the light path grammar (match.ts) —
 * no svelte, no node builtins — so islands can import `ogygia/router/client` directly.
 */
import { fill } from './match.js';
import type { HrefParams, Params } from './view.js';

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: unknown,
		message?: string
	) {
		super(message ?? `endpoint answered ${status}`);
	}
}

/** keys of `App` that carry verb `M` — endpoint entries only (pages have no verb slots). */
type KeysWith<App, M extends string> = {
	[K in keyof App & string]: App[K] extends Record<M, { out: unknown }> ? K : never;
}[keyof App & string];
type OutOf<App, K extends keyof App, M extends string> =
	App[K] extends Record<M, { out: infer O }> ? O : unknown;
type InOf<App, K extends keyof App, M extends string> =
	App[K] extends Record<M, { in: infer I }> ? I : undefined;

/** `params` is REQUIRED exactly when the pattern has any (same rule as `href`). */
type ParamsOpt<K extends string> = {} extends Params<K>
	? { params?: HrefParams<K> }
	: { params: HrefParams<K> };
type BodyOpt<In> = undefined extends In ? { body?: In } : { body: In };
type CallOpts<K extends string, In = undefined> = ParamsOpt<K> &
	BodyOpt<In> & {
		search?: Record<string, string | number>;
		headers?: Record<string, string>;
	};
/** args tuple: the options object itself is omittable when nothing in it is required. */
type CallArgs<K extends string, In = undefined> = {} extends Params<K> & (undefined extends In ? {} : { body: In })
	? [opts?: CallOpts<K, In>]
	: [opts: CallOpts<K, In>];

export interface ApiClientOptions {
	/** Extra headers on every call (auth tokens, signed hops — compose with `sign_headers`). */
	headers?: Record<string, string>;
	/** Custom fetch (a Kit event's cookie-forwarding fetch, a test stub). Default: global. */
	fetch?: typeof fetch;
}

export interface ApiClient<App> {
	get<K extends KeysWith<App, 'get'>>(path: K, ...args: CallArgs<K>): Promise<OutOf<App, K, 'get'>>;
	delete<K extends KeysWith<App, 'delete'>>(
		path: K,
		...args: CallArgs<K>
	): Promise<OutOf<App, K, 'delete'>>;
	post<K extends KeysWith<App, 'post'>>(
		path: K,
		...args: CallArgs<K, InOf<App, K, 'post'>>
	): Promise<OutOf<App, K, 'post'>>;
	put<K extends KeysWith<App, 'put'>>(
		path: K,
		...args: CallArgs<K, InOf<App, K, 'put'>>
	): Promise<OutOf<App, K, 'put'>>;
	patch<K extends KeysWith<App, 'patch'>>(
		path: K,
		...args: CallArgs<K, InOf<App, K, 'patch'>>
	): Promise<OutOf<App, K, 'patch'>>;
}

export function api<App>(base: string, opts: ApiClientOptions = {}): ApiClient<App> {
	const f = opts.fetch ?? fetch;
	const root = base.replace(TRAILING_SLASH_RE, '');
	const call = async (method: string, path: string, o: Record<string, unknown> = {}) => {
		let url = root + fill(path, (o.params as Record<string, string | number>) ?? {});
		if (o.search) {
			const qs = new URLSearchParams();
			for (const [k, v] of Object.entries(o.search as Record<string, string | number>))
				qs.set(k, String(v));
			url += `?${qs}`;
		}
		const has_body = o.body !== undefined;
		const res = await f(url, {
			method,
			headers: {
				accept: 'application/json',
				...(has_body ? { 'content-type': 'application/json' } : {}),
				...opts.headers,
				...(o.headers as Record<string, string>)
			},
			...(has_body ? { body: JSON.stringify(o.body) } : {})
		});
		if (res.status === 204) return undefined;
		const is_json = (res.headers.get('content-type') ?? '').includes('json');
		const body = is_json ? await res.json().catch(() => undefined) : await res.text();
		if (!res.ok) throw new ApiError(res.status, body);
		return body;
	};
	return {
		get: (p, ...a) => call('GET', p, a[0] as never),
		delete: (p, ...a) => call('DELETE', p, a[0] as never),
		post: (p, ...a) => call('POST', p, a[0] as never),
		put: (p, ...a) => call('PUT', p, a[0] as never),
		patch: (p, ...a) => call('PATCH', p, a[0] as never)
	} as ApiClient<App>;
}

const TRAILING_SLASH_RE = /\/+$/;
