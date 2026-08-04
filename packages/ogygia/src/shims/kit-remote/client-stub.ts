// Plan A stub for Kit's client `client.js`, scoped to Kit's remote-functions importers only.
// Provides exactly what those modules read — WITHOUT pulling Kit's router graph.
import { parse } from 'devalue';
import { transport } from 'virtual:ogygia/transport';
import { goto as spaGoto, invalidateAll as spaInvalidateAll } from '../../runtime/router.js';

const t = transport || {};
export const app = {
	hooks: { transport: t },
	decoders: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.decode])),
	encoders: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.encode]))
};
export function goto(url) {
	return spaGoto(url);
}
export const _goto = goto;
export function invalidateAll() {
	return spaInvalidateAll();
}
export function set_nearest_error_page() {}
export const query_map = new Map();
export const live_query_map = new Map();

/** SSR-resolved remote responses, keyed by `create_remote_key(id, payload)`. Kit's reused
 *  `Query`/`LiveQuery` constructors consume a matching node here (`{ v }` / `{ e }`) instead of
 *  fetching. This is the SAME singleton object Kit's remote-functions read on the client — one
 *  instance across island chunks + the runtime in a single client build. */
type RemoteNode = { v?: unknown; e?: [number, unknown] };
export const query_responses: Record<string, RemoteNode> = {};
export const prerender_responses: Record<string, RemoteNode> = {};

/**
 * Seed `query_responses` from the `<script type="application/ogygia-remote">` the server emits on
 * csr=false pages (see `ogygiaHandle`). Mirrors Kit's own `start()` boot-seed, but sourced from a
 * side-channel because Kit only serializes remote data when csr===true. Parsed with the app's
 * transport decoders so custom types round-trip. Called ONCE by the runtime before the first
 * island hydrates, so every reused `Query` constructor finds its SSR value and never re-fetches.
 * @param {string} text devalue-stringified `{ q?, l?, f? }` payload
 */
export function seed_query_responses(text: string): void {
	let data: { q?: Record<string, RemoteNode>; l?: Record<string, RemoteNode>; f?: Record<string, RemoteNode> } | null;
	try {
		data = parse(text, app.decoders) as typeof data;
	} catch {
		return;
	}
	if (!data) return;
	const { q = {}, l = {}, f = {} } = data;
	for (const k in q) query_responses[k] = q[k];
	for (const k in l) query_responses[k] = l[k];
	for (const k in f) query_responses[k] = f[k];
}
