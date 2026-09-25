/**
 * Where a region's props sidecar (`<script type="application/ogygia-props" data-ogygia-props>`) is.
 *
 * Two placements, ONE lookup:
 *  - KEYED, at the end of `<body>`: an island rendered in Kit's own page pass records its sidecar
 *    into the request (Region.svelte → the handle), which emits every island's props once, after
 *    the content, keyed by the region's fingerprint (`data-og-fp` on the element ==
 *    `data-ogygia-props="<fp>"` AND `id="og-props-<fp>"` on the script). Bytes the browser must
 *    download before the hero used to sit right after each island — a landing page carried 480 KB
 *    of props above its LCP image. Identical islands (same entry + props → same fp) share one script.
 *    Found by `getElementById` — the browser's id map, O(1); an attribute `querySelector` per island
 *    was a full light-DOM walk each (150 islands × 2,000 elements on a measured page).
 *  - ADJACENT, the next element sibling (skipping `<link>` CSS hints): every other render root —
 *    a hole response, a baked held region, a streamed late region, a router document, a foreign
 *    fragment, a snippet crossing into an island — keeps the sidecar right after the region, so the
 *    HTML stays self-contained wherever it is spliced. Keyed by attribute only, NEVER by id: its
 *    fingerprint may repeat one the tail (or another root) carries, and an id must be unique.
 * The tail's id lookup runs first, then the sibling walk; a whole-tree attribute query only on a
 * miss. Server islands and held deferred regions carry no `data-og-fp` and always ride adjacent.
 *
 * A third source, checked first: a sidecar RESTORED onto a region that has none in the DOM — a
 * hydrating hole Kit rendered again in the browser after it gave up hydrating the document (the
 * client leg renders no sidecar; the runtime remembered the SSR one under the hole's identity and
 * attaches the clone here, off the DOM, so Kit's tree is never edited under it).
 */
const restored_sidecars = new WeakMap<Element, HTMLScriptElement>();

/** Attach a remembered props sidecar to a region whose DOM carries none (see above). */
export function restore_props_sidecar(region: Element, sidecar: HTMLScriptElement): void {
	restored_sidecars.set(region, sidecar);
}

export function props_sidecar_of(region: Element): HTMLScriptElement | null {
	const restored = restored_sidecars.get(region);
	if (restored) return restored;
	const fp = region.getAttribute('data-og-fp');
	// The region's own tree: the live document, a foreign (fetched) document, or a shadow root.
	const root = region.getRootNode() as Document | ShadowRoot | Element;
	if (fp && 'getElementById' in root) {
		const keyed = root.getElementById('og-props-' + fp); // the TAIL's (the only one with an id)
		if (keyed) return keyed as HTMLScriptElement;
	}
	// ADJACENT: the region's own next sibling — keyed by attribute only (an adjacent sidecar never
	// carries an id: its fingerprint may repeat elsewhere in the document) or unkeyed.
	let sib = region.nextElementSibling;
	while (sib) {
		if (sib.tagName === 'SCRIPT' && sib.hasAttribute('data-ogygia-props'))
			return sib as HTMLScriptElement;
		if (sib.tagName === 'LINK') {
			sib = sib.nextElementSibling;
			continue;
		}
		break;
	}
	// A detached subtree (no id map), or a document rendered before the tail stamped ids (a frozen
	// copy, a fragment from an older build): one attribute query, only on a miss. Same fingerprint,
	// same props — any match is the right payload.
	if (fp) {
		const found = (root as ParentNode).querySelector?.(`script[data-ogygia-props="${fp}"]`);
		if (found) return found as HTMLScriptElement;
	}
	return null;
}
