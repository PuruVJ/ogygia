/**
 * Light up MANY elements on the page at once — the profile's "these 290 shadow roots", "every
 * element Icon.svelte rendered", "the largest paint". Boxes live in the dock's own shadow root (a
 * fixed, click-through layer), follow scroll and resize while shown, and cap at a few hundred so a
 * huge match stays cheap. No Svelte: plain DOM, one layer, replaced on each call.
 */

let root: ShadowRoot | null = null;
let layer: HTMLDivElement | null = null;
let current: Element[] = [];
let label = '';
let frame = 0;
const MAX_BOXES = 400;

/** The dock's shadow root (ui-app.ts sets it at mount). */
export function set_highlight_root(r: ShadowRoot): void {
	root = r;
}

function draw(): void {
	frame = 0;
	if (!layer) return;
	layer.textContent = '';
	const vw = innerWidth;
	const vh = innerHeight;
	let n = 0;
	for (const el of current) {
		if (n >= MAX_BOXES) break;
		const r = el.getBoundingClientRect();
		if (!r.width && !r.height) continue;
		if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
		const b = document.createElement('div');
		b.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:1.5px solid #f472b6;background:rgba(244,114,182,.12);border-radius:3px;box-sizing:border-box`;
		layer.appendChild(b);
		n++;
	}
	if (label) {
		const tag = document.createElement('div');
		tag.textContent = label;
		tag.style.cssText =
			'position:fixed;left:12px;top:12px;padding:4px 9px;border-radius:7px;background:#831843;color:#fce7f3;font:600 11px/1.4 ui-monospace,monospace;box-shadow:0 4px 12px rgba(0,0,0,.35)';
		layer.appendChild(tag);
	}
}

const schedule = () => {
	if (!frame) frame = requestAnimationFrame(draw);
};

/** Show boxes over `els` (with a caption); `scroll` brings the first into view. */
export function highlight(els: Element[], caption = '', scroll = false): void {
	if (!root) return;
	current = els;
	label = caption;
	if (!layer) {
		layer = document.createElement('div');
		layer.setAttribute('data-og-highlight', '');
		layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483600';
		root.prepend(layer);
		addEventListener('scroll', schedule, { passive: true, capture: true });
		addEventListener('resize', schedule, { passive: true });
	}
	if (scroll && els[0]) {
		try {
			els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
		} catch {
			// detached
		}
	}
	schedule();
}

export function clear_highlight(): void {
	current = [];
	label = '';
	if (layer) {
		layer.remove();
		layer = null;
		removeEventListener('scroll', schedule, { capture: true } as EventListenerOptions);
		removeEventListener('resize', schedule);
	}
}

/** How many boxes are shown now (tests). */
export function highlighted_count(): number {
	return current.length;
}
