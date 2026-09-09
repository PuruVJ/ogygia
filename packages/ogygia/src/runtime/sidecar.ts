/**
 * Where a region's props sidecar (`<script type="application/ogygia-props" data-ogygia-props>`) is.
 *
 * Two placements, ONE lookup:
 *  - KEYED, at the end of `<body>`: an island rendered in Kit's own page pass records its sidecar
 *    into the request (Region.svelte → the handle), which emits every island's props once, after
 *    the content, keyed by the region's fingerprint (`data-og-fp` on the element ==
 *    `data-ogygia-props="<fp>"` on the script). Bytes the browser must download before the hero
 *    used to sit right after each island — a landing page carried 480 KB of props above its LCP
 *    image. Identical islands (same entry + props → same fp) share one script.
 *  - ADJACENT, the next element sibling (skipping `<link>` CSS hints): every other render root —
 *    a hole response, a baked held region, a streamed late region, a router document, a foreign
 *    fragment — keeps the sidecar right after the region, so the HTML stays self-contained wherever
 *    it is spliced.
 * The keyed lookup runs first (a keyed sidecar may also sit adjacent, e.g. in dev or a fragment);
 * the sibling walk is the fallback. Server islands and held deferred regions carry no `data-og-fp`
 * and always ride adjacent.
 */
export function props_sidecar_of(region: Element): HTMLScriptElement | null {
	const fp = region.getAttribute('data-og-fp');
	if (fp) {
		const root = region.getRootNode() as Document | ShadowRoot | Element;
		const keyed = (root && 'querySelector' in root ? root : region.ownerDocument)?.querySelector(
			`script[data-ogygia-props="${fp}"]`
		);
		if (keyed) return keyed as HTMLScriptElement;
	}
	let sib = region.nextElementSibling;
	while (sib) {
		if (sib.tagName === 'SCRIPT' && sib.matches('script[data-ogygia-props]'))
			return sib as HTMLScriptElement;
		if (sib.tagName === 'LINK') {
			sib = sib.nextElementSibling;
			continue;
		}
		break;
	}
	return null;
}
