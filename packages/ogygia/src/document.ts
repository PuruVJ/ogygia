/**
 * `document()` — the document a region stands in.
 *
 * ogygia's one primitive is the region: component + props with rendering and waking rules. Every
 * region so far has lived inside a document that Kit happened to serve. `document()` is the other
 * half: given a region value, mint the COMPLETE ogygia document around it — doctype, head
 * (`<svelte:head>` content, scoped-CSS links, the runtime bootstrap), body (the region's HTML,
 * `<ogygia-region>` shells, props sidecars) — returned as a `Response` you can serve from anywhere:
 * a `handle` in hooks, a `+server.ts` endpoint, the profiler. No URL, no routing, no "page"
 * semantics — where it's served is the caller's business.
 *
 * It renders through `<Region of={…}>` inside the live request (Kit's `getRequestEvent()` ALS), so
 * ALL the per-request machinery regions already have simply applies: `claim_region_css` links each
 * scoped stylesheet once, props sidecars ride next to their shells, islands inside wake on their own
 * schedules, and the emitted markup is a standard ogygia page — the SPA router body-swaps into and
 * out of it like any Kit-served page.
 *
 * Deliberately NOT the app's `app.html`: that template belongs to Kit's build and does not exist at
 * runtime. The shell here is ogygia's own, minimal one — extra head content goes through
 * `<svelte:head>` in the components or the `head` option.
 *
 * Server-only (it renders): call it from a handle / endpoint / server module.
 */
import { render } from 'svelte/server';
import { stringify } from 'devalue';
import type { Component } from 'svelte';
import Region from './Region.svelte';
import { PageSeed } from './server/page-seed.js';
import { page_seed_reducers } from './server/page-stream.js';
import runtime_url from 'virtual:ogygia/runtime-url';
import { freeze_capture_active } from './freeze/capture.js';
import { try_get_request_store } from '@sveltejs/kit/internal/server';
import { kit_render_context, type KitPage } from './server/kit-context.js';
import { record_page } from './page-seed-registry.js';

const AMP_G = /&/g;
const LT_G = /</g;
const GT_G = />/g;
const TITLE_TAG_RE = /<title[\s>]/i;
import dev_hmr_url from 'virtual:ogygia/dev-hmr-url';
import {
	enabled as router_enabled,
	viewTransitions as router_view_transitions
} from 'virtual:ogygia/router-config';
import {
	page_declares_router_meta,
	page_declares_runtime_script,
	page_declares_dev_hmr_script
} from './server/head-presence.js';
import type { RegionValue } from './region.js';

export interface DocumentOptions {
	/** `<title>` — used only when no component set one via `<svelte:head>` (the component wins). */
	title?: string;
	/** Raw extra head HTML (meta tags, fonts, …), appended after the rendered head. */
	head?: string;
	/** HTTP status (default 200). */
	status?: number;
	/** Extra/override response headers. `content-type` and `cache-control: no-store` are the defaults
	 *  (under an eligible FREEZE request the cache-control default is left to the verdict). */
	headers?: HeadersInit;
	/** `<html lang>` (default 'en'). */
	lang?: string;
	/** Seed for `$app/state` inside islands (`page.data`/`params`/`url`, `route.id`, `form`). The router
	 *  passes it so islands on a rendered page read `$page` just like on a Kit-served page. Promises in
	 *  `data`/`form` aren't streamed here — a non-serializable leaf drops that one field. */
	pageState?: {
		url?: { href?: string };
		params?: Record<string, string | undefined>;
		route?: { id: string | null };
		status?: number;
		data?: unknown;
		form?: unknown;
		error?: unknown;
	};
}

const escape_text = (s: string) =>
	s.replace(AMP_G, '&amp;').replace(LT_G, '&lt;').replace(GT_G, '&gt;');

/** The `page` object Kit's server `$app/state` answers from (Kit's `props.page` shape), built from
 *  the caller's seed when the router passed one, else from the live request (URL, status) with
 *  empty data — so `page.url`/`page.status` are always true and `page.data` never throws on any
 *  ogygia-rendered document. Also RECORDED into the request's page snapshot, so the nested island
 *  renders under this document rebuild the same context (see server/kit-context.ts). */
function kit_page_context(options: DocumentOptions): KitPage {
	const s = options.pageState;
	const store = try_get_request_store() as { event?: { url?: URL } } | undefined;
	const href = s?.url?.href ?? store?.event?.url?.href;
	const page: KitPage = {
		url: href ? new URL(href) : undefined,
		params: s?.params ?? {},
		route: s?.route ?? { id: null },
		status: s?.status ?? options.status ?? 200,
		data: s?.data ?? {},
		form: s?.form ?? null,
		error: s?.error ?? null,
		state: {}
	};
	record_page({
		url: href ? { href } : undefined,
		params: page.params,
		route: page.route,
		status: page.status,
		data: page.data,
		form: page.form,
		error: page.error
	});
	return page;
}

/**
 * Render a region into a complete ogygia document and return it as a `Response`.
 *
 * ```ts
 * import { document } from 'ogygia/server';
 * import { region } from 'ogygia';
 *
 * return document(region(Dashboard, { stats }), { title: 'ogygia profiler' });
 * ```
 */
export async function document(
	of: RegionValue | PromiseLike<RegionValue>,
	options: DocumentOptions = {}
): Promise<Response> {
	// `<Region of>` accepts exactly what callers hold — a region value or its promise. Rendered inside
	// the current request so css-claiming and props capture key off the live RequestEvent.
	const r = await render(Region as unknown as Component<{ of: unknown }>, {
		props: { of: await of },
		context: kit_render_context(kit_page_context(options))
	});

	const head: string[] = [];
	// The component's own <svelte:head> (title, meta, region-CSS links Region claimed) comes first —
	// it is the page's voice; the option only fills gaps.
	head.push(r.head);
	if (options.head) head.push(options.head);
	const head_so_far = () => head.join('');
	if (options.title && !TITLE_TAG_RE.test(head_so_far())) {
		head.push(`<title>${escape_text(options.title)}</title>`);
	}
	// The same three injections the handle makes into a Kit page, presence-checked the same way
	// (head-presence guards against prose false-matches). The runtime bootstrap is unconditional —
	// a document with islands needs it with or without the SPA router.
	if (router_enabled && !page_declares_router_meta(head_so_far())) {
		head.push(`<meta name="ogygia-router" content="${router_view_transitions ? 'vt' : 'plain'}">`);
	}
	if (runtime_url && !page_declares_runtime_script(head_so_far())) {
		head.push(`<script type="module" data-ogygia-runtime src="${runtime_url}"></script>`);
	}
	if (dev_hmr_url && !page_declares_dev_hmr_script(head_so_far())) {
		head.push(`<script type="module" data-ogygia-dev-hmr src="${dev_hmr_url}"></script>`);
	}
	// Page-state seed (`$app/state` inside islands) — the same `application/ogygia-page` side-channel the
	// handle injects for a Kit page, built here from the caller's snapshot (router-rendered pages).
	if (options.pageState) {
		const s = options.pageState;
		const payload = PageSeed.serialize(
			{
				url: s.url,
				params: s.params as Record<string, string> | undefined,
				route: s.route,
				status: s.status,
				data: s.data,
				form: s.form,
				error: s.error
			},
			(v: unknown) => stringify(v, page_seed_reducers)
		);
		if (payload)
			head.push(`<script type="application/ogygia-page" data-ogygia-page>${payload}</script>`);
	}

	const html =
		`<!doctype html>\n<html lang="${escape_text(options.lang ?? 'en')}">` +
		`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
		head.join('') +
		`</head><body>${r.body}</body></html>`;

	const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
	// Programmatic documents are rendered per request — `no-store` by default, cacheable ones
	// override via `headers`. Under an eligible FREEZE request the verdict owns this header
	// instead (frozen → `public, s-maxage`; refused → `private, no-store`): stamping it here
	// would read as the APP refusing, and no router page could ever freeze.
	if (!freeze_capture_active()) headers.set('cache-control', 'no-store');
	if (options.headers) {
		for (const [k, v] of new Headers(options.headers)) headers.set(k, v);
	}
	return new Response(html, { status: options.status ?? 200, headers });
}
