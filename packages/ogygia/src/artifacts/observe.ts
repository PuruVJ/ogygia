/**
 * artifacts — observed purity. The handle patches the event IN PLACE (identity preserved — Kit
 * and its WeakMap-keyed internals keep working) and records personalization reads during the
 * render. The verdict (see hooks.ts) then decides: store, or stay per-request.
 *
 * The vary-bucket law (bcms delta 1): a read that resolved to its DEFAULT value — cookie
 * `undefined`, `locals.user` an empty object — still stores. That IS the canonical render
 * (the cookie-less CDN key, formalized). A NON-default observed value → per-request in v1.
 *
 * Blind spots (documented): reads that happen BEFORE this handle in the `sequence()` (upstream
 * auth handles priming `locals` — we see the LOCALS read instead, which is why locals are
 * observed too) and `Date.now()`/randomness in loads ("true at render time", the prerender/ISR
 * contract).
 */
import type { RequestEvent } from '@sveltejs/kit';

/** Personalization-bearing request headers: reading one during an eligible render disqualifies
 *  the page. Everything else (host, sec-fetch-*, accept-encoding, …) is delivery plumbing. */
const DISQUALIFYING_HEADERS = new Set([
	'cookie',
	'authorization',
	'accept-language',
	'user-agent',
	'referer',
	'x-user',
	'x-user-id',
	'x-session',
	'x-session-id'
]);

export interface Observation {
	/** First personalization read that returned a NON-default value, or null — the verdict input.
	 *  Named (`cookie:consent`, `header:accept-language`, `locals.user`) for the dev note. */
	disqualified_by: string | null;
	/** The render (or the app) wrote a cookie — always per-request. */
	wrote_cookie: boolean;
}

/** Default-valued reads still store: undefined/null/''/false, empty plain object, empty array. */
function is_default_value(value: unknown): boolean {
	if (value === undefined || value === null || value === '' || value === false) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') {
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null) {
			return Object.keys(value as Record<string, unknown>).length === 0;
		}
	}
	return false;
}

/**
 * Patch `event.cookies` / `event.locals` / `event.request.headers` in place, recording reads.
 * Returns the live observation the verdict reads after the render. Patching is per-request
 * (the event dies with the request) — nothing to restore.
 */
export function observe_event(event: RequestEvent): Observation {
	const obs: Observation = { disqualified_by: null, wrote_cookie: false };
	const disqualify = (label: string) => {
		if (obs.disqualified_by === null) obs.disqualified_by = label;
	};

	// cookies — record non-default gets; any write during the render is per-request by definition.
	const cookies = event.cookies;
	const orig_get = cookies.get.bind(cookies);
	const orig_get_all = cookies.getAll.bind(cookies);
	const orig_set = cookies.set.bind(cookies);
	const orig_delete = cookies.delete.bind(cookies);
	cookies.get = ((name: string, opts?: never) => {
		const value = orig_get(name, opts);
		if (!is_default_value(value)) disqualify(`cookie:${name}`);
		return value;
	}) as typeof cookies.get;
	cookies.getAll = ((opts?: never) => {
		const all = orig_get_all(opts);
		if (all.length > 0) disqualify('cookies.getAll');
		return all;
	}) as typeof cookies.getAll;
	cookies.set = ((...args: Parameters<typeof orig_set>) => {
		obs.wrote_cookie = true;
		return orig_set(...args);
	}) as typeof cookies.set;
	cookies.delete = ((...args: Parameters<typeof orig_delete>) => {
		obs.wrote_cookie = true;
		return orig_delete(...args);
	}) as typeof cookies.delete;

	// request headers — patch the bound `get` on THIS Headers instance.
	const headers = event.request.headers;
	const orig_header_get = headers.get.bind(headers);
	headers.get = ((name: string) => {
		const value = orig_header_get(name);
		if (value !== null && DISQUALIFYING_HEADERS.has(name.toLowerCase())) {
			disqualify(`header:${name.toLowerCase()}`);
		}
		return value;
	}) as typeof headers.get;

	// locals — upstream handles personalize BEFORE this handle runs, so the RENDER's read of
	// what they wrote is the observable moment. Default-shaped values (empty user object) pass.
	event.locals = new Proxy(event.locals, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof prop === 'string' && !is_default_value(value) && typeof value !== 'function') {
				disqualify(`locals.${prop}`);
			}
			return value;
		}
	});

	return obs;
}
