/**
 * THE REGION-CSS TAG — one place that turns a region's CSS href into head markup, for every emitter
 * (Region.svelte's island / held dual / content body sheets, the handle's hole-answer sheets).
 *
 * Two shapes, one channel: under Kit's `inlineStyleThreshold` the build kept the asset's text in
 * the island-deps handoff (`islandCssInline`), and the tag is `<style data-ogygia-region-css="href">`
 * — no request before first paint; otherwise it is the `<link rel="stylesheet" … data-ogygia-region-css>`
 * it always was. Both carry the resolved href as the channel's identity: the runtime hoists either
 * from a fetched answer into `<head>` and dedupes them against what the page already has by that
 * value, and the router keys a head `<style>` on it across swaps.
 */
import { islandCssInline } from 'virtual:ogygia/island-deps';
import { escape_attr as attr } from '../escape.js';

/**
 * @param href the handoff's public href (the `islandCss()` value — the inline lookup key)
 * @param resolved the same href through `asset()` (base / assets applied) — what the tag carries
 */
export function region_css_tag(href: string, resolved: string): string {
	const text = islandCssInline(href);
	if (text !== null) return `<style data-ogygia-region-css="${attr(resolved)}">${text}</style>`;
	// DEV: the href is the island's module (Vite serves component CSS only inside it; the runtime
	// imports it for its styles). As a stylesheet link the browser fetched the JS a second time as
	// CSS — an empty sheet, and an error per island in engines that are strict about the MIME type.
	// As a modulepreload, the fetch is the one the runtime's import() uses. (Every runtime path finds
	// these tags by `data-ogygia-region-css`, whatever their rel; a built app's hrefs are `.css`.)
	if (!is_css_href(href)) return `<link rel="modulepreload" href="${attr(resolved)}" data-ogygia-region-css>`;
	return `<link rel="stylesheet" href="${attr(resolved)}" data-ogygia-region-css>`;
}

/** `….css` or `….css?…` (string search: one per region CSS tag). */
function is_css_href(href: string): boolean {
	const q = href.indexOf('?');
	return (q === -1 ? href : href.slice(0, q)).endsWith('.css');
}
