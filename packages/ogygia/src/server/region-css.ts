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

const AMP_G = /&/g;
const QUOT_G = /"/g;
const LT_G = /</g;

function attr(value: string): string {
	return value.replace(AMP_G, '&amp;').replace(QUOT_G, '&quot;').replace(LT_G, '&lt;');
}

/**
 * @param href the handoff's public href (the `islandCss()` value — the inline lookup key)
 * @param resolved the same href through `asset()` (base / assets applied) — what the tag carries
 */
export function region_css_tag(href: string, resolved: string): string {
	const text = islandCssInline(href);
	if (text !== null) return `<style data-ogygia-region-css="${attr(resolved)}">${text}</style>`;
	return `<link rel="stylesheet" href="${attr(resolved)}" data-ogygia-region-css>`;
}
