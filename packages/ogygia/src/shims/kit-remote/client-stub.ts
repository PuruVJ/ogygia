// Plan A stub for Kit's client `client.js`, scoped to Kit's remote-functions importers only.
// Provides exactly what those modules read — WITHOUT pulling Kit's router graph.
import { parse } from 'devalue';
import { encoders, decoders } from 'virtual:ogygia/transport';
import { query_responses, prerender_responses, query_map, live_query_map } from './remote-cache.js';

export { query_responses, prerender_responses, query_map, live_query_map };

export const app = { decoders, encoders };
// Navigation is the `$app/navigation` shim's: Kit's real router on a Kit-booted document, the
// ogygia runtime's handle on one ogygia owns, the browser with neither. A remote form's redirect or
// refresh inside an island on a Kit page then goes through Kit, never a full reload. (`refreshAll`:
// a remote `form()` calls it after a successful submit.)
export { goto as _goto, refreshAll } from '../app-navigation.js';
export function set_nearest_error_page() {}
/** A remote call's error, as the page shows it — an `error()`'s own body, else a 500. There
 *  are no client hooks to consult (the island world has no Kit client). */
export async function handle_error(error: unknown): Promise<{ status?: number; message: string }> {
	const body = (error as { body?: { message?: string } } | null)?.body;
	return body && typeof body.message === 'string' ? (body as { message: string }) : { status: 500, message: 'Internal Error' };
}

/**
 * Seed `query_responses` from the `<script type="application/ogygia-remote">` the server emits on
 * csr=false pages (see `ogygiaHandle`). Mirrors Kit's own `start()` boot-seed, but sourced from a
 * side-channel because Kit only serializes remote data when csr===true. Parsed with the app's
 * transport decoders so custom types round-trip. Called ONCE by the runtime before the first
 * island hydrates, so every reused `Query` constructor finds its SSR value and never re-fetches.
 * @param text devalue-stringified `{ q?, l?, f? }` payload
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
