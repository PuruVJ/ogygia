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
 *    fragment — keeps the sidecar right after the region, so the HTML stays self-contained wherever
 *    it is spliced.
 * The keyed lookup runs first (a keyed sidecar may also sit adjacent, e.g. in dev or a fragment);
 * the sibling walk is the fallback. Server islands and held deferred regions carry no `data-og-fp`
 * and always ride adjacent.
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
	if (fp) {
		// The region's own tree: the live document, a foreign (fetched) document, or a shadow root.
		const root = region.getRootNode() as Document | ShadowRoot | Element;
		const keyed =
			'getElementById' in root
				? root.getElementById('og-props-' + fp)
				: // A detached subtree (no id map): the attribute walk, on that subtree only.
					root.querySelector(`script[data-ogygia-props="${fp}"]`);
		if (keyed) return keyed as HTMLScriptElement;
		// PRE-ID DOCUMENTS: a document rendered before the server stamped `id="og-props-<fp>"` on the
		// keyed sidecar (a frozen copy, a fragment from an older build). One attribute query, only on
		// that miss — delete this fallback once no such document can still be served.
		const legacy = (root as Document).querySelector?.(`script[data-ogygia-props="${fp}"]`);
		if (legacy) return legacy as HTMLScriptElement;
	}
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
	return null;
}
