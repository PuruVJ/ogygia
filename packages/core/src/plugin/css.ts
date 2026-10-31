/**
 * `ogygia/plugin/css` — the CSS of components a programmatic router renders (see the server-router-css
 * notes + compiler/link/router-css.ts). Such a page's component is a VALUE, not a Kit route, so nothing
 * file-derived links its scoped `<style>` / plain `.css` imports. The build registers every component a
 * page module (`b.pageModules()`) can reach in a runtime registry (`virtual:ogygia/router-css`); this
 * turns the components ONE render places into the `<link>` / `<style>` head tags `document()` hoists,
 * deduped against the request's held-region links.
 *
 * Its own subpath: the generated registry is a virtual module, so it stays out of `ogygia/plugin` (every
 * plugin's server realm) — and it is imported on the first call, never at module load.
 */
import { DEV } from 'esm-env';
import { router_css_active, router_css_of } from '../router-css.ts';
import { claim_region_css } from '../context.ts';

// ── regexes
const STYLE_CLOSE_G = /<\/style/gi;

// The generated virtual only resolves under the app's Vite pipeline; anywhere else (bare node,
// `ogygia mcp`) the import rejects and CSS linking is a silent no-op — those realms render data.
let rcss_ready: Promise<unknown> | null | undefined;
let warned_inactive = false;
function registry_ready(): Promise<unknown> | null {
	if (rcss_ready === undefined) {
		try {
			rcss_ready = import('virtual:ogygia/router-css').catch(() => null);
		} catch {
			rcss_ready = null;
		}
	}
	return rcss_ready;
}

/** Head tags for the components ONE render places (a layout chain + its page or error component):
 *  each component's whole-tree CSS, linked once per request. */
export async function componentCssHead(components: readonly unknown[]): Promise<string> {
	const ready = registry_ready();
	const registry = ready ? await ready : null;
	if (DEV && registry && !warned_inactive && components.length && !router_css_active()) {
		warned_inactive = true;
		console.warn(
			"[ogygia] a page rendered outside Kit's routes, but no plugin declared page modules, so its components' CSS is not linked. Using `@ogygia/router`? List `router()` from `@ogygia/router/vite` beside `ogygia()` in vite.config `plugins`."
		);
	}
	const entries = components.flatMap((c) => router_css_of(c));
	if (!entries.length) return '';
	const keys = entries.map((e) => e.key);
	let fresh = new Set(claim_region_css(keys));
	// Off-request realm (bare `router.fetch`, no Kit event): the per-request claim is inert — dedupe
	// locally so the document still styles. On-request an empty result means everything was already
	// linked by an earlier render (correctly emit nothing); the sentinel probe tells the two apart.
	if (fresh.size === 0 && keys.length) {
		try {
			if (claim_region_css(['\0og-rcss-probe']).length === 0) fresh = new Set(keys);
		} catch {
			fresh = new Set(keys);
		}
	}
	let head = '';
	for (const e of entries) {
		if (!fresh.has(e.key)) continue;
		fresh.delete(e.key); // shared child CSS can repeat across components — link once
		if (e.href) head += `<link rel="stylesheet" href="${e.href}" data-ogygia-region-css>`;
		else if (e.css)
			head += `<style data-ogygia-rcss>${e.css.replace(STYLE_CLOSE_G, '<\\/style')}</style>`;
	}
	return head;
}
