/**
 * Absolute URLs inside a hole's HTML.
 *
 * A server island renders in its OWN request — `/__ogygia__?…` — and Kit's `asset()` (with the
 * default `paths.relative`) emits every URL relative to THAT request: `./_app/immutable/x.js`,
 * `./__ogygia__?…`. The HTML then lands in a page at any depth (`/docs/guides/`), and a
 * region entry / nested-hole endpoint / region-css link inside it would resolve against the page:
 * `/docs/guides/_app/…` → 404, a dead island in a live hole. The batch parcel and an
 * ESI-stitched hole (the CDN splices the bytes straight into the page) have the same problem, so
 * the fix is on the server, once, at the point the response is assembled: resolve every relative
 * ogygia URL against the endpoint request URL and emit it root-absolute (Kit `base` included).
 * Absolute (`/…`) and scheme'd (foreign federation entries) values are left alone.
 */

// The three attribute sites ogygia writes URLs into hole HTML. Values are attribute-escaped
// (`&` → `&amp;`), so the resolver un-escapes, resolves, and re-escapes.
const REGION_TAG_G = /<ogygia-region\b[^>]*>/g;
const REGION_URL_ATTR_G = /\b(entry|endpoint)="([^"]*)"/g;
const REGION_CSS_LINK_G = /<link\b[^>]*data-ogygia-region-css[^>]*>/g;
const LINK_HREF = /\bhref="([^"]*)"/;
/** An INLINED region sheet's open tag: its identity attribute carries the href it stands for. */
const REGION_CSS_STYLE_G = /<style\b[^>]*data-ogygia-region-css="[^"]*"[^>]*>/g;
const STYLE_IDENTITY = /\bdata-ogygia-region-css="([^"]*)"/;
const RELATIVE_START = /^\.{1,2}\//;
const AMP_ENTITY_G = /&amp;/g;
const AMP_G = /&/g;

function resolve_attr(value: string, base: URL): string {
	if (!value || !RELATIVE_START.test(value)) return value;
	let resolved: URL;
	try {
		resolved = new URL(value.replace(AMP_ENTITY_G, '&'), base);
	} catch {
		return value;
	}
	if (resolved.origin !== base.origin) return value;
	return (resolved.pathname + resolved.search + resolved.hash).replace(AMP_G, '&amp;');
}

/** Rewrite the relative `entry` / `endpoint` / region-css `href` values in `html` to root-absolute
 *  paths resolved against `base` (the endpoint request URL). */
export function absolutize_hole_html(html: string, base: URL): string {
	if (!html.includes('<ogygia-region') && !html.includes('data-ogygia-region-css')) return html;
	return html
		.replace(REGION_TAG_G, (tag) =>
			tag.replace(
				REGION_URL_ATTR_G,
				(_m, name: string, value: string) => `${name}="${resolve_attr(value, base)}"`
			)
		)
		.replace(REGION_CSS_LINK_G, (tag) =>
			tag.replace(LINK_HREF, (_m, value: string) => `href="${resolve_attr(value, base)}"`)
		)
		.replace(REGION_CSS_STYLE_G, (tag) =>
			tag.replace(
				STYLE_IDENTITY,
				(_m, value: string) => `data-ogygia-region-css="${resolve_attr(value, base)}"`
			)
		);
}
