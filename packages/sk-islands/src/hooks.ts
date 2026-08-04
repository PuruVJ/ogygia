// SvelteKit server `handle` for server islands. Serves GET `<base>/_islands?id=…&props=…&sig=…`
// by verifying the HMAC-signed props payload, rendering the island component server-side (with
// the real request context — cookies, remote functions, `await` all work), and returning the
// island HTML for the runtime to swap in.
//
//   // src/hooks.server.js
//   import { ogygiaHandle } from 'ogygia/hooks';
//   import { sequence } from '@sveltejs/kit/hooks';
//   export const handle = sequence(ogygiaHandle(), myOtherHandle);
//
// Composable with `sequence()` — it only intercepts the `/_islands` path and otherwise calls
// `resolve(event)`.
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { Handle } from '@sveltejs/kit';
import * as devalue from 'devalue';
import { base } from '$app/paths';
import { islands as island_modules } from 'virtual:ogygia/server-manifest';
import { secret } from 'virtual:ogygia/secret';
import { verify } from './server/hmac.js';
import { b64urlDecode } from './server/payload.js';

const ENDPOINT = '/_islands';

/**
 * @param {Object} [options]
 * @param {string} [options.endpoint='/_islands'] path (relative to base) the handle serves
 * @returns {import('@sveltejs/kit').Handle}
 */
export function ogygiaHandle(options: { endpoint?: string } = {}): Handle {
	const endpoint = (base || '') + (options.endpoint || ENDPOINT);

	return async ({ event, resolve }) => {
		if (event.url.pathname !== endpoint) return resolve(event);
		return await render_island(event.url);
	};
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
