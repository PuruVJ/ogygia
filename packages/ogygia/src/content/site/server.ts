/**
 * Server-only remote layer for an ogygia site. The ONLY ogygia module that imports `$app/server`, so
 * it must be used from a `.remote.ts` (Kit guarantees those run on the server). Mirrors
 * `withRemotes()` from `ogygia/content/server`: the browser-safe `site()` defines the site once;
 * `remotes(site)` mints the wire access.
 *
 * ```ts
 * // docs.remote.ts
 * import { remotes } from 'ogygia/content/server';
 * import { site } from './docs';
 * export const { nav, search } = remotes(site, { base: '/docs' });
 * ```
 *
 * Two remotes:
 *  - `nav` — the nav tree, PRERENDERED (one static artifact, hrefs baked for the mount).
 *  - `search` — the ON-DEMAND search brain over the wire (query mode). The server builds a lazy
 *    in-memory index the first time it's called; the client never receives the corpus. This is the
 *    dynamic-site path — distinct from the prerendered `search.json` + worker (the static path).
 */
import { prerender, query } from '$app/server';
import type { ContentMode } from '../server.js';
import type { Site, SiteMeta } from './site.js';
import type { SearchHit } from './search.js';
import type { PageView, NavTree } from './types.js';

/** Minimal Standard Schema string validator (avoids a valibot dep in the library). */
const string_arg = {
	['~standard']: {
		version: 1 as const,
		vendor: 'ogygia-content',
		validate(value: unknown) {
			if (typeof value === 'string') return { value };
			return { issues: [{ message: 'Expected string' }] };
		}
	}
};

/** Standard Schema: `string | undefined` — for remotes whose argument is optional (`nav()`). */
const optional_string_arg = {
	['~standard']: {
		version: 1 as const,
		vendor: 'ogygia-content',
		validate(value: unknown) {
			if (value === undefined || typeof value === 'string') return { value };
			return { issues: [{ message: 'Expected string or undefined' }] };
		}
	}
};

export type SiteRemotes = {
	/**
	 * The nav tree as a prerendered remote — awaited by an island sidebar. On a `dimensions()` site
	 * pass a slug (or bare coordinate prefix like `'kit/'`) to get THAT coordinate's tree; no
	 * argument (or `''`) is the default coordinate. Prerendered per distinct argument.
	 */
	nav: (slug?: string) => Promise<NavTree>;
	/** The whole SHELL bundle (`{ nav, switcher, data }`) as ONE prerendered remote — feed it straight
	 *  to `<Shell {meta}>` so the layout never imports the corpus. On a `dimensions()` site, pass the
	 *  slug for that coordinate's tree + switcher. */
	meta: (slug?: string) => Promise<SiteMeta>;
	/** On-demand full-text search over the wire (query mode) — server brain, corpus stays server-side. */
	search: (q: string) => Promise<SearchHit[]>;
	/** One page view over the wire (query mode). The entry's lazy `body` region crosses as a signed
	 *  ticket via the app's `transport` hook (universal hooks) and `<Doc>`/`<Region>` renders it. */
	page: (slug: string) => Promise<PageView | null>;
};

/**
 * Mint a site's Kit remotes. `base` is the mount prefix (baked into `nav` hrefs and `search` hit
 * hrefs); default `''` (root mount).
 *
 * `modes` picks each remote's wire mode (the same dial as `withRemotes`): **`prerender`** (default
 * for `nav` + `doc` — static payloads, required when the awaiting pages prerender; `dynamic: true`
 * keeps runtime resolution for uncovered args) or **`query`** (per-request compute — a preview
 * deployment, a context-gated site). `search` is inherently per-request and always `query`.
 */
export function remotes(
	site: Site,
	opts: { base?: string; modes?: { nav?: ContentMode; page?: ContentMode } } = {}
): SiteRemotes {
	const base = opts.base ?? '';
	const mode = { nav: opts.modes?.nav ?? 'prerender', page: opts.modes?.page ?? 'prerender' };
	// The slug argument selects the dimension coordinate; absent / '' = the default coordinate —
	// so ONE remote serves every topic/version/locale tree.
	const nav_fn = (slug?: string) => site.nav(slug ? { base, slug } : { base });
	// `source` is a lazy server-only reader (a function — not wire data); drop it. The body IS wire
	// data once AWAITED: awaiting bakes its SSR HTML, and the transport ships it as an HTML-only
	// ticket (inline body) or a signed ticket with markup (dual). Same-pass SSR still renders the
	// component directly — the baked HTML is for the wire crossing.
	const doc_fn = async (slug: string) => {
		const view = await site.page(slug, { base });
		if (!view) return null;
		const { source: _source, ...entry } = view.entry as typeof view.entry & { source?: unknown };
		const body = entry.body ? await entry.body : undefined;
		return { ...view, entry: { ...entry, ...(body ? { body } : {}) } };
	};
	// The shell bundle for a slug — one payload the leak-free layout feeds to `<Shell {meta}>`.
	const meta_fn = (slug?: string) => site.meta(slug ? { base, slug } : { base });
	return {
		nav: (mode.nav === 'query'
			? query(optional_string_arg, nav_fn)
			: prerender(optional_string_arg, nav_fn, { dynamic: true })) as unknown as (
			slug?: string
		) => Promise<NavTree>,
		meta: (mode.nav === 'query'
			? query(optional_string_arg, meta_fn)
			: prerender(optional_string_arg, meta_fn, { dynamic: true })) as unknown as (
			slug?: string
		) => Promise<SiteMeta>,
		search: query(string_arg, (q: string) => site.search(q, { base })) as unknown as (
			q: string
		) => Promise<SearchHit[]>,
		page: (mode.page === 'query'
			? query(string_arg, doc_fn)
			: prerender(string_arg, doc_fn, { dynamic: true })) as unknown as (
			slug: string
		) => Promise<PageView | null>
	};
}
