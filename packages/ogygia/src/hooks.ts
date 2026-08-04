// SvelteKit server `handle` for server islands. Serves GET `<base>/🏝️ogygia🏝️?id=…&props=…&sig=…`
// by verifying the HMAC-signed props payload, rendering the island component server-side (with
// the real request context — cookies, remote functions, `await` all work), and returning the
// island HTML for the runtime to swap in.
//
//   // src/hooks.server.js
//   import { ogygiaHandle } from 'ogygia/hooks';
//   import { sequence } from '@sveltejs/kit/hooks';
//   export const handle = sequence(ogygiaHandle(), myOtherHandle);
//
// Composable with `sequence()` — it only intercepts the `/🏝️ogygia🏝️` path and otherwise calls
// `resolve(event)`.
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { Handle } from '@sveltejs/kit';
import { try_get_request_store } from '@sveltejs/kit/internal/server';
import type { RequestState } from '@sveltejs/kit/internal/server';
import * as devalue from 'devalue';
// Route MATCHING needs the ABSOLUTE base-prefixed path to compare against `event.url.pathname`.
// `resolve()` is deliberately RELATIVE on the server (for browser-resolved link generation), so
// it's the wrong tool here — server-side pathname matching legitimately uses `base` (the
// deprecation of `base` targets href generation, which is what ServerIsland/Island use resolve/
// asset for).
import { base } from '$app/paths';
import { islands as island_modules } from 'virtual:ogygia/server-manifest';
import { secret } from 'virtual:ogygia/secret';
import { verify } from './server/hmac.js';
import { b64urlDecode } from './server/payload.js';
import { DEFAULT_ISLANDS_ENDPOINT } from './server/endpoint.js';

/**
 * @param {Object} [options]
 * @param {string} [options.endpoint] path (relative to base) the handle serves; default is the
 *   clash-safe island-emoji route. Must start with `/`.
 * @returns {import('@sveltejs/kit').Handle}
 */
export function ogygiaHandle(options: { endpoint?: string } = {}): Handle {
	// absolute base-prefixed endpoint, DECODED form (raw emoji).
	const endpoint = (base || '') + (options.endpoint || DEFAULT_ISLANDS_ENDPOINT);

	return async ({ event, resolve }) => {
		// Compare against the DECODED request pathname so the percent-encoded UTF-8 the browser
		// sends matches our raw-emoji literal regardless of how Kit hands us the URL.
		if (decodeURIComponent(event.url.pathname) !== endpoint) {
			// Flicker fix: on csr=false pages Kit resolves top-level `await query()` calls during
			// SSR (populating the internal request store's `remote.implicit`) but only serializes
			// them into the page when csr===true. We capture the resolved query responses and emit
			// a `<script type="application/ogygia-remote">` side-channel the runtime reads to seed
			// the reused client query cache BEFORE islands hydrate — so no re-fetch, no flash. The
			// store is captured synchronously here (active inside Kit's `with_request_store`); it is
			// the SAME object reference Kit mutates during the render inside `resolve`.
			const store = try_get_request_store();
			return resolve(event, {
				transformPageChunk: async ({ html }) => inject_remote_seed(html, store?.state)
			});
		}
		return await render_island(event.url);
	};
}

/**
 * Collect SSR-resolved implicit query responses from the request store and inject them as a
 * side-channel script. Only regular queries (`type: 'query'`) are seeded — `query.live` still
 * connects and `.refresh()` still re-fetches. Skips pages Kit already booted (csr===true), which
 * carry Kit's own remote serialization.
 */
async function inject_remote_seed(
	html: string,
	state: RequestState | undefined
): Promise<string> {
	// A Kit-booted (csr=true) page serializes remote data itself; our islands ride that hydration.
	// `state` is undefined in `vite dev`: Kit's internal request store is a module singleton that,
	// under Vite's dev SSR (+ pnpm), resolves to a DIFFERENT instance than the externalized library
	// gets — so `try_get_request_store()` reads an empty store. We degrade gracefully (no seed →
	// islands re-fetch on hydration, exactly the pre-fix behavior). The production bundle is a
	// single module graph, so the store is shared and seeding is active. See TODO.md "dev caveat".
	if (!state || /__sveltekit_/.test(html)) return html;
	const implicit = state.remote?.implicit;
	if (!implicit) return html;

	const q: Record<string, { v: unknown }> = {};
	for (const [internals, record] of implicit) {
		// Private (non-exported) remote functions have no `id` and must never be serialized.
		if (!internals.id || internals.type !== 'query') continue;
		for (const key in record) {
			const remote_key = internals.id + '/' + key; // = create_remote_key(id, payload)
			// Reuse the promise cached during SSR (same value the HTML rendered from), so a
			// non-deterministic query (e.g. `new Date()`) seeds the EXACT rendered value.
			const promise = state.remote.data?.get(internals)?.[key] ?? record[key]();
			// Seed only queries that have already resolved; a still-pending query is left for the
			// client to fetch (an entry without `v` would hydrate as `undefined`).
			let resolved = true;
			await Promise.race([
				Promise.resolve(promise).then(
					(v) => {
						if (resolved) q[remote_key] = { v };
					},
					() => {
						/* errored queries are not seeded — the island re-fetches and handles it */
					}
				),
				Promise.resolve().then(() => {
					resolved = false;
				})
			]);
		}
	}

	if (Object.keys(q).length === 0) return html;

	// Transport-aware devalue so custom types (universal `transport` hook) round-trip; the runtime
	// parses with the mirror decoders. Escape `<` so the payload can never break out of the script.
	const transport = state.transport || {};
	const reducers = Object.fromEntries(
		Object.entries(transport).map(([name, codec]) => [name, codec.encode])
	);
	const payload = devalue.stringify({ q }, reducers).replaceAll('<', '\\u003C');
	const script = `<script type="application/ogygia-remote">${payload}</script>`;
	return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
}

/**
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function render_island(url) {
	const id = url.searchParams.get('id');
	const payload = url.searchParams.get('props') ?? '';
	const sig = url.searchParams.get('sig') ?? '';

	const load = id ? island_modules[id] : undefined;
	if (!load) {
		return new Response('Unknown island', { status: 404 });
	}
	// Reject tampered/forged payloads BEFORE decoding or rendering.
	if (!verify(secret, payload, sig)) {
		return new Response('Invalid island signature', { status: 403 });
	}

	let props;
	try {
		props = devalue.parse(b64urlDecode(payload));
	} catch {
		return new Response('Invalid island payload', { status: 400 });
	}

	let body;
	try {
		const mod = await load();
		// `render()` is thenable; awaiting settles any `await`/remote work in the component.
		const out = await render(mod.default as Component<Record<string, unknown>>, { props });
		body = out.body;
	} catch (err) {
		return new Response('Island render failed', { status: 500 });
	}

	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			// `private` keeps shared/CDN caches out (responses are cookie-personalized) while
			// letting THIS browser reuse the `<link rel="preload">` response for the runtime
			// fetch (a short max-age is enough; the runtime fetches each island once).
			'cache-control': 'private, max-age=30'
		}
	});
}
