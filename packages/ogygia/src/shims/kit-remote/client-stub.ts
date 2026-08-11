// Plan A stub for Kit's client `client.js`, scoped to Kit's remote-functions importers only.
// Provides exactly what those modules read — WITHOUT pulling Kit's router graph.
import { parse } from 'devalue';
import { transport } from 'virtual:ogygia/transport';
import { slots } from '../../runtime/slots.js';
import {
	query_responses,
	prerender_responses,
	query_map,
	live_query_map
} from './remote-cache.js';

export {
	query_responses,
	prerender_responses,
	query_map,
	live_query_map
};

const t = transport || {};
export const app = {
	hooks: { transport: t },
	decoders: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.decode])),
	encoders: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.encode]))
};
// Read the router's nav via the `slots` registry instead of statically importing `router.js` (~10 KB).
// The router feature fills `slots.nav` when it loads; if no router is present (no `<Router/>`, no SPA
// nav — like every app that just seeds a remote query), fall back to a full-page navigation. This is
// what keeps router out of every app that doesn't route.
export function goto(url) {
	if (slots.nav) return slots.nav.goto(url);
	location.href = String(url);
	return Promise.resolve();
}
export const _goto = goto;
export function invalidateAll() {
	if (slots.nav) return slots.nav.invalidateAll();
	location.reload();
	return Promise.resolve();
}
export function set_nearest_error_page() {}

/**
 * Seed `query_responses` from the `<script type="application/ogygia-remote">` the server emits on
 * csr=false pages (see `ogygiaHandle`). Mirrors Kit's own `start()` boot-seed, but sourced from a
 * side-channel because Kit only serializes remote data when csr===true. Parsed with the app's
 * transport decoders so custom types round-trip. Called ONCE by the runtime before the first
 * island hydrates, so every reused `Query` constructor finds its SSR value and never re-fetches.
 * @param {string} text devalue-stringified `{ q?, l?, f? }` payload
 */
export function seed_query_responses(text: string): void {
	let data: {
		q?: Record<string, (typeof query_responses)[string]>;
		p?: Record<string, (typeof prerender_responses)[string]>;
		l?: Record<string, (typeof query_responses)[string]>;
		f?: Record<string, (typeof query_responses)[string]>;
	} | null;
	try {
		data = parse(text, app.decoders) as typeof data;
	} catch {
		return;
	}
	if (!data) return;
	const { q = {}, p = {}, l = {}, f = {} } = data;
	for (const k in q) query_responses[k] = q[k];
	for (const k in l) query_responses[k] = l[k];
	for (const k in f) query_responses[k] = f[k];
	// PRERENDER remotes seed a separate cache (Kit parity, client.js) — without this a prerender
	// remote awaited inside an island re-fetches on hydrate and the island re-mounts (FOUC).
	for (const k in p) prerender_responses[k] = p[k];
}
