/**
 * A WEB COMPONENT'S OWN CLASS TOKENS SURVIVE HYDRATION. A custom element's `class` has two writers:
 * Svelte (the author's classes) and the component itself, which may put state on its own host (a
 * theme over a dark image, an indicator position). Svelte's hydration writes `class` WHOLE whenever
 * it differs from Svelte's value (svelte `set_class`), so every token the component added before
 * the island woke was dropped — and a component that does not render again never puts it back.
 *
 * Ogygia knows which tokens are Svelte's for each custom element the restorer reset
 * (runtime/restore.ts records them as `__og_svelte_class`): everything else on that host is the
 * component's. So around an island's hydrate: before it, note each such host's non-Svelte tokens;
 * after it, put back the ones Svelte's write removed. The tokens are read JUST BEFORE the hydrate,
 * not as served: between restore and hydrate the component's own first render (or a script of its)
 * may have added or dropped one from client state, and that is what it wants now. Either order of
 * that render and the hydrate ends the same. Svelte's own tokens are never touched (a
 * client value that differs from the server's still wins), and an element hydration replaced is
 * skipped. An app without a server transform has no such hosts and pays one property read per
 * custom element in the island.
 */

/** The expando the restorer writes on a custom element it reset: Svelte's class, as Svelte rendered it. */
export const SVELTE_CLASS = '__og_svelte_class';

type Hosted = Element & { [SVELTE_CLASS]?: string };

/** Each restored custom element under `region` with tokens that are not Svelte's: [host, tokens]. */
export function note_host_classes(region: Element): Array<[Element, string[]]> | null {
	let out: Array<[Element, string[]]> | null = null;
	for (const el of region.getElementsByTagName('*')) {
		const svelte = (el as Hosted)[SVELTE_CLASS];
		if (svelte === undefined) continue;
		const own = new Set(svelte.split(' '));
		let theirs: string[] | null = null;
		for (const t of el.classList) if (!own.has(t)) (theirs ??= []).push(t);
		if (theirs) (out ??= []).push([el, theirs]);
	}
	return out;
}

/** Put back the component's tokens a hydration write removed. */
export function keep_host_classes(noted: Array<[Element, string[]]> | null): void {
	if (!noted) return;
	for (const [el, theirs] of noted) {
		if (!el.isConnected) continue; // (hydration replaced it: a fresh element is the component's to dress)
		for (const t of theirs) if (!el.classList.contains(t)) el.classList.add(t);
	}
}
