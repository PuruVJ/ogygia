/**
 * The server-router CSS handoff read at render (see server-router-css memory + link/router-css.ts):
 * a router page's component is a VALUE, not a Kit route, so nothing file-derived links its scoped
 * `<style>` / plain `.css` imports. `virtual:ogygia/router-css` fills a runtime registry; this turns
 * the components ONE render places into the `<link>` / `<style>` head tags `document()` hoists,
 * deduped through `claim_region_css` (shared with held-region links). Shared by v1 + v2 routers.
 */
import { router_css_of } from '../router-css.js';
import { claim_region_css } from '../context.js';
import type { AnyComponent } from './define.js';

// The generated virtual only resolves under the app's Vite pipeline; anywhere else (bare node,
// `ogygia mcp`) the import rejects and CSS linking is a silent no-op — those realms render data.
const rcss_ready: Promise<unknown> | null = (() => {
	try {
		return import('virtual:ogygia/router-css').catch(() => null);
	} catch {
		return null;
	}
})();

/** Head tags for the components ONE render places (layout chain + page/error component). */
export async function router_css_head(components: AnyComponent[]): Promise<string> {
	if (rcss_ready) await rcss_ready;
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
			head += `<style data-ogygia-rcss>${e.css.replace(/<\/style/gi, '<\\/style')}</style>`;
	}
	return head;
}
