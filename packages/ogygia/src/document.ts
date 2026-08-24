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
import type { Component } from 'svelte';
import Region from './Region.svelte';
import runtime_url from 'virtual:ogygia/runtime-url';
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
	/** Extra/override response headers. `content-type` and `cache-control: no-store` are the defaults. */
	headers?: HeadersInit;
	/** `<html lang>` (default 'en'). */
	lang?: string;
}

const escape_text = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
		props: { of: await of }
	});

	const head: string[] = [];
	// The component's own <svelte:head> (title, meta, region-CSS links Region claimed) comes first —
	// it is the page's voice; the option only fills gaps.
	head.push(r.head);
	if (options.head) head.push(options.head);
	const head_so_far = () => head.join('');
	if (options.title && !/<title[\s>]/i.test(head_so_far())) {
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

	const html =
		`<!doctype html>\n<html lang="${escape_text(options.lang ?? 'en')}">` +
		`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
		head.join('') +
		`</head><body>${r.body}</body></html>`;

	const headers = new Headers({
		'content-type': 'text/html; charset=utf-8',
		// Programmatic documents are rendered per request — cacheable ones can override.
		'cache-control': 'no-store'
	});
	if (options.headers) {
		for (const [k, v] of new Headers(options.headers)) headers.set(k, v);
	}
	return new Response(html, { status: options.status ?? 200, headers });
}
