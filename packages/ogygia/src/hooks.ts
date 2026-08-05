// SvelteKit server `handle` for signed region holes (defer/server). Serves
// GET `<base>/🏝️ogygia🏝️?id=…&props=…&exp=…&sig=…` by verifying the region MAC, rendering the
// region component server-side (cookies, remote functions, `await` all work), and returning HTML
// for the runtime to swap in.
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
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { try_get_request_store } from '@sveltejs/kit/internal/server';
import type { RequestState } from '@sveltejs/kit/internal/server';
import * as devalue from 'devalue';
// Route MATCHING needs the ABSOLUTE base-prefixed path to compare against `event.url.pathname`.
// `resolve()` is deliberately RELATIVE on the server (for browser-resolved link generation), so
// it's the wrong tool here — server-side pathname matching uses `base`.
import { base } from '$app/paths';
import { page } from '$app/state';
import { islands as island_modules } from 'virtual:ogygia/server-manifest';
import { secret } from 'virtual:ogygia/secret';
import { rateLimit as rate_limit_cfg } from 'virtual:ogygia/rate-limit';
import { sessionCookie as session_cookie } from 'virtual:ogygia/session-cookie';
import { verify, region_mac_message } from './server/hmac.js';
import { B64Url } from './server/payload.js';
import { DEFAULT_ISLANDS_ENDPOINT } from './server/endpoint.js';
import { html_has_kit_bootstrap } from './runtime/kit-boot.js';
import { RateLimiter } from './server/rate-limit.js';
import { PageSeed } from './server/page-seed.js';

/** Max b64url props blob accepted before MAC work (DoS / amplification bound). */
const MAX_PROPS_LEN = 8192;
/** Hard cap on rendered region HTML (bytes). */
const MAX_REGION_BODY = 2_000_000;
/** Abort slow region SSR. */
const RENDER_TIMEOUT_MS = 10_000;

/** Anti-framing on every region response (P1-COOKIE harvested-URL embedding). */
const REGION_FRAME_HEADERS = {
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy': "frame-ancestors 'none'"
} as const;

function region_response(body: BodyInit | null, init: { status: number; headers?: Record<string, string> }) {
	return new Response(body, {
		status: init.status,
		headers: { ...REGION_FRAME_HEADERS, ...init.headers }
	});
}

/**
 * Decode a request pathname without throwing on malformed percent-encoding (SEC-05).
 * @returns {string | null} decoded path, or null if the encoding is invalid
 */
function decode_pathname(pathname: string): string | null {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return null;
	}
}

/** Resolve a rate-limit key; fail closed (null) when the adapter cannot identify the client. */
function client_ip(event: RequestEvent): string | null {
	try {
		return event.getClientAddress();
	} catch {
		/* some adapters omit client address */
	}
	const h = event.request.headers;
	const forwarded =
		h.get('cf-connecting-ip') ||
		h.get('x-real-ip') ||
		h.get('x-forwarded-for')?.split(',')[0]?.trim();
	return forwarded || null;
}

class OgygiaHandle {
	readonly #endpoint: string;
	readonly render_rate: RateLimiter;
	readonly probe_rate: RateLimiter;

	constructor(options: { endpoint?: string } = {}) {
		this.#endpoint = (base || '') + (options.endpoint || DEFAULT_ISLANDS_ENDPOINT);
		this.render_rate = new RateLimiter({
			max: rate_limit_cfg.max,
			windowMs: rate_limit_cfg.windowMs
		});
		/** Cheap pre-HMAC probe budget — forged traffic pays this, not full render quota (HMAC-CPU-DOS). */
		this.probe_rate = new RateLimiter({
			max: rate_limit_cfg.max <= 0 ? 0 : Math.max(rate_limit_cfg.max * 5, 120),
			windowMs: rate_limit_cfg.windowMs
		});
	}

	handle: Handle = async ({ event, resolve }) => {
		const path = decode_pathname(event.url.pathname);
		if (path === null) {
			return new Response('Bad Request', { status: 400 });
		}
		// Compare against the DECODED request pathname so the percent-encoded UTF-8 the browser
		// sends matches our raw-emoji literal regardless of how Kit hands us the URL.
		if (path !== this.#endpoint) {
			// Flicker fix: on csr=false pages Kit resolves top-level `await query()` calls during
			// SSR (populating the internal request store's `remote.implicit`) but only serializes
			// them into the page when csr===true. We capture the resolved query responses and emit
			// a `<script type="application/ogygia-remote">` side-channel the runtime reads to seed
			// the reused client query cache BEFORE islands hydrate — so no re-fetch, no flash. The
			// store is captured synchronously here (active inside Kit's `with_request_store`); it is
			// the SAME object reference Kit mutates during the render inside `resolve`.
			const store = try_get_request_store();
			return resolve(event, {
				transformPageChunk: async ({ html }) => this.inject_client_seeds(html, store?.state)
			});
		}
		return await this.render_region(event);
	};

	/**
	 * Document-level side-channels: one page snapshot + optional remote query seed.
	 * Skips Kit-booted (csr=true) pages which serialize remotes themselves.
	 */
	async inject_client_seeds(html: string, state: RequestState | undefined): Promise<string> {
		if (html_has_kit_bootstrap(html)) return html;

		const scripts: string[] = [];

		// Single page seed (PAGE-DUP) — islands no longer emit per-region copies.
		const page_payload = PageSeed.serialize(page);
		if (page_payload) {
			scripts.push(`<script type="application/ogygia-page" data-ogygia-page>${page_payload}</script>`);
		}

		if (state?.remote?.implicit) {
			const remote_script = await this.build_remote_seed_script(state);
			if (remote_script) scripts.push(remote_script);
		}

		if (scripts.length === 0) return html;
		const block = scripts.join('');
		return html.includes('</body>') ? html.replace('</body>', block + '</body>') : html + block;
	}

	async build_remote_seed_script(state: RequestState): Promise<string | null> {
		const implicit = state.remote?.implicit;
		if (!implicit) return null;

		const q: Record<string, { v: unknown }> = {};
		for (const [internals, record] of implicit) {
			// Private (non-exported) remote functions have no `id` and must never be serialized.
			if (!internals.id || internals.type !== 'query') continue;
			for (const key in record) {
				const remote_key = internals.id + '/' + key;
				const promise = state.remote.data?.get(internals)?.[key] ?? record[key]();
				let resolved = true;
				await Promise.race([
					Promise.resolve(promise).then(
						(v) => {
							if (resolved) q[remote_key] = { v };
						},
						() => {
							/* errored queries are not seeded */
						}
					),
					Promise.resolve().then(() => {
						resolved = false;
					})
				]);
			}
		}

		if (Object.keys(q).length === 0) return null;

		const transport = state.transport || {};
		const reducers = Object.fromEntries(
			Object.entries(transport).map(([name, codec]) => [name, codec.encode])
		);
		const payload = devalue.stringify({ q }, reducers).replaceAll('<', '\\u003C');
		return `<script type="application/ogygia-remote">${payload}</script>`;
	}

	/**
	 * Verify the region MAC, then render. Unknown ids and bad MACs both return 403 so the
	 * existence of a region id is not an oracle (SEC-01). Expiry is part of the MAC message.
	 *
	 * Ordering: length/exp → probe rate (pre-HMAC) → verify → render rate → render.
	 * Probe stops forged CPU amplification; render budget is only charged after a valid MAC.
	 */
	async render_region(event: RequestEvent) {
		const url = event.url;
		const ip = client_ip(event);
		if (!ip) {
			// Fail closed — shared 'unknown' bucket was an unfair DoS vector.
			return region_response('Too Many Requests', { status: 429 });
		}

		const id = url.searchParams.get('id') ?? '';
		const payload = url.searchParams.get('props') ?? '';
		const exp_raw = url.searchParams.get('exp') ?? '';
		const sig = url.searchParams.get('sig') ?? '';

		// Length-gate BEFORE HMAC (P5-HMAC-CPU).
		if (!id || payload.length > MAX_PROPS_LEN) {
			return region_response('Forbidden', { status: 403 });
		}

		const exp = Number(exp_raw);
		if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
			return region_response('Forbidden', { status: 403 });
		}

		// Pre-HMAC probe — forged floods hit this, not render() (HMAC-CPU-DOS).
		if (this.probe_rate.limited(ip)) {
			return region_response('Too Many Requests', { status: 429 });
		}

		// Optional session bind: cookie value must match the session sealed into the MAC.
		const session = session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';

		// Verify before consulting the manifest — bad MAC never distinguishes unknown vs known id.
		if (!verify(secret, region_mac_message(id, exp_raw, payload, session), sig)) {
			return region_response('Forbidden', { status: 403 });
		}

		// Valid capability — now charge the per-IP render budget.
		if (this.render_rate.limited(ip)) {
			return region_response('Too Many Requests', { status: 429 });
		}

		const load = island_modules[id];
		if (!load) {
			return region_response('Forbidden', { status: 403 });
		}

		let props;
		try {
			props = devalue.parse(B64Url.decode(payload));
		} catch {
			// Same status as bad MAC — no decode oracle (STATUS-ORACLE).
			return region_response('Forbidden', { status: 403 });
		}

		let body: string;
		try {
			const mod = await load();
			const rendered = render(mod.default as Component<Record<string, unknown>>, { props });
			const timed = await Promise.race([
				Promise.resolve(rendered).then((out) => out.body as string),
				new Promise<never>((_, rej) =>
					setTimeout(() => rej(new Error('region render timeout')), RENDER_TIMEOUT_MS)
				)
			]);
			body = timed;
		} catch {
			return region_response('Region render failed', { status: 500 });
		}

		if (body.length > MAX_REGION_BODY) {
			return region_response('Forbidden', { status: 403 });
		}

		return region_response(body, {
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				// `private` keeps shared/CDN caches out (responses are cookie-personalized) while
				// letting THIS browser reuse the `<link rel="preload">` response for the runtime
				// fetch (a short max-age is enough; the runtime fetches each region once).
				'cache-control': 'private, max-age=30'
			}
		});
	}
}

/**
 * @param {Object} [options]
 * @param {string} [options.endpoint] path (relative to base) the handle serves; default is the
 *   clash-safe island-emoji route. Must start with `/`.
 * @returns {import('@sveltejs/kit').Handle}
 */
export function ogygiaHandle(options: { endpoint?: string } = {}): Handle {
	const instance = new OgygiaHandle(options);
	return (args) => instance.handle(args);
}
