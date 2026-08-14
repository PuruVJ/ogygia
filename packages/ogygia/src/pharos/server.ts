/**
 * Server-only remote layer for a pharos site. The ONLY pharos module that imports `$app/server`, so
 * it must be used from a `.remote.ts` (Kit guarantees those run on the server). Mirrors
 * `withRemotes()` from `ogygia/content/server`: the browser-safe `pharos()` defines the site once;
 * `remotes(site)` mints the wire access.
 *
 * ```ts
 * // docs.remote.ts
 * import { remotes } from 'ogygia/pharos/server';
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
import type { Site } from './pharos.js';
import type { SearchHit } from './search.js';
import type { NavTree } from './types.js';

/** Minimal Standard Schema string validator (avoids a valibot dep in the library). */
const string_arg = {
	['~standard']: {
		version: 1 as const,
		vendor: 'ogygia-pharos',
		validate(value: unknown) {
			if (typeof value === 'string') return { value };
			return { issues: [{ message: 'Expected string' }] };
		}
	}
};

export type PharosRemotes = {
	/** The full nav tree as a prerendered remote — awaited by an island sidebar. */
	nav: () => Promise<NavTree>;
	/** On-demand full-text search over the wire (query mode) — server brain, corpus stays server-side. */
	search: (q: string) => Promise<SearchHit[]>;
};

/**
 * Mint a site's Kit remotes. `base` is the mount prefix (baked into `nav` hrefs and `search` hit
 * hrefs); default `''` (root mount).
 */
export function remotes(site: Site, opts: { base?: string } = {}): PharosRemotes {
	const base = opts.base ?? '';
	return {
		nav: prerender(() => site.nav({ base }), { dynamic: true }) as unknown as () => Promise<NavTree>,
		search: query(string_arg, (q: string) => site.search(q, { base })) as unknown as (q: string) => Promise<SearchHit[]>
	};
}
