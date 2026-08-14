/**
 * Roving tabindex — the shared keyboard primitive behind every pharos navigation surface (sidebar,
 * on-this-page, the tab bar). A composite widget should be ONE tab stop: `Tab` lands on it once, then
 * arrow keys move focus among its items. This is a Svelte ATTACHMENT factory (`{@attach roving(...)}`)
 * — it needs the container node, wires listeners on mount, and returns the teardown Svelte calls on
 * unmount. Focus-only: it never activates anything (arrows rove; `Enter`/`Space`/click do their native
 * thing), so it composes cleanly over links (native navigation) and over manually-activated tabs (a
 * separate select handler).
 */
import { on } from 'svelte/events';

export interface RovingOptions {
	/** Which descendants are the roving items (e.g. `.ph-nav-link`). */
	selector: string;
	/** Arrow axis. Nav rails are `'vertical'` (Up/Down); a tab bar is `'horizontal'` (Left/Right). */
	orientation?: 'vertical' | 'horizontal';
	/** Wrap past the ends (default `true`). */
	loop?: boolean;
}

/** True if an item is the "current" one — the natural entry tab stop (active page, selected tab, …). */
function is_current(el: Element): boolean {
	const cur = el.getAttribute('aria-current');
	return (
		(cur != null && cur !== 'false') ||
		el.getAttribute('aria-selected') === 'true' ||
		el.classList.contains('ph-active')
	);
}

/**
 * Attach roving-tabindex behavior to `container`. The entry tab stop is the CURRENT item (or the first
 * if none); arrows/Home/End move focus and carry the single `tabindex="0"` with it.
 */
export function roving(opts: RovingOptions) {
	const vertical = opts.orientation !== 'horizontal';
	const loop = opts.loop !== false;
	return (container: HTMLElement) => {
		const items = () => [...container.querySelectorAll<HTMLElement>(opts.selector)];
		const seed = items();
		if (!seed.length) return;

		const set_stops = (active: number) => {
			const els = items();
			els.forEach((el, j) => (el.tabIndex = j === active ? 0 : -1));
		};
		// Seed one tab stop: the current item, else the first.
		const seeded = seed.findIndex(is_current);
		set_stops(seeded < 0 ? 0 : seeded);

		const next = vertical ? 'ArrowDown' : 'ArrowRight';
		const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
		const off = on(container, 'keydown', (e: KeyboardEvent) => {
			const els = items();
			const cur = els.indexOf(document.activeElement as HTMLElement);
			if (cur < 0) return; // focus isn't on a roving item — leave the event alone
			let n = cur;
			if (e.key === next) n = cur + 1;
			else if (e.key === prev) n = cur - 1;
			else if (e.key === 'Home') n = 0;
			else if (e.key === 'End') n = els.length - 1;
			else return;
			n = loop ? (n + els.length) % els.length : Math.max(0, Math.min(els.length - 1, n));
			e.preventDefault();
			els.forEach((el, j) => (el.tabIndex = j === n ? 0 : -1));
			els[n].focus();
		});
		return () => off();
	};
}
