/** The value of `attr` on `el` or its NEAREST ancestor that has it, crossing shadow-root boundaries (an
 *  island inside a web component's shadow tree still finds the block around the component). */
export function nearest_attr(el: Element, attr: string): string | null {
	const sel = `[${CSS.escape(attr)}]`;
	let at: Element | null = el;
	while (at) {
		const hit = at.closest(sel);
		if (hit) return hit.getAttribute(attr);
		const root = at.getRootNode();
		at = root instanceof ShadowRoot ? root.host : null;
	}
	return null;
}
