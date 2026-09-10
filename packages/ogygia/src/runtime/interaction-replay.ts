/**
 * The interaction wake's SECOND half (see ./interaction.ts): once the island is live, put back
 * what the visitor did while it was waking — typed values, focus, the canceled clicks — at each
 * element's ADDRESS (hydration may have replaced the nodes). Loaded when the first interaction
 * island arms; never part of the boot.
 */
import { resolve_address, type FieldSnapshot, type QueuedClick } from './interaction.js';
import { emit as dt_emit } from '../devtools/bus.js';

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

/** Re-apply what the user typed while the island was waking, at each field's ADDRESS; sync `bind:`. */
function restore_fields(region: Element, fields: FieldSnapshot[]) {
	for (const s of fields) {
		const el = resolve_address(region, s.addr);
		if (!el || el.tagName !== s.tag) continue;
		const f = el as HTMLInputElement;
		if (f === s.el) continue; // hydration reused the node — nothing was lost
		let changed = false;
		if (f.value !== s.el.value) {
			f.value = s.el.value;
			changed = true;
		}
		if (s.el instanceof HTMLInputElement && f.checked !== s.el.checked) {
			f.checked = s.el.checked;
			changed = true;
		}
		if (changed) {
			try {
				const { selectionStart, selectionEnd } = s.el;
				if (selectionStart != null && selectionEnd != null) {
					f.setSelectionRange(selectionStart, selectionEnd);
				}
			} catch {
				// non-text input types reject selection access
			}
			f.dispatchEvent(new Event('input', { bubbles: true }));
			f.dispatchEvent(new Event('change', { bubbles: true }));
		}
	}
}

/**
 * Replay the queued clicks in arrival order at each click's address (tag-checked against drift).
 * One frame later: hydration just (re)bound the island's web-component wiring (a dropdown web
 * component's `target` element, set by a reactive statement) and many components apply such
 * changes in their own render tick. A synchronous replay lands before that tick and toggles
 * nothing; after a frame the component is settled.
 */
export function replay_clicks(region: Element, queued: QueuedClick[]) {
	const replay = () => {
		for (const q of queued) {
			const t = resolve_address(region, q.addr);
			if (!t || t.tagName !== q.tag) continue;
			// A web component's shadow-internal handler (a design-system button's inner <button>) sits
			// BELOW the host: a click dispatched on the host never reaches it. Hydration claims
			// the host node and never touches its shadow tree, so the captured deep node is
			// still live — replay there (composed, so the host's listeners hear it too).
			const deep = q.deep as Node | null;
			const target = deep && deep.isConnected && t.shadowRoot?.contains(deep) ? deep : t;
			target.dispatchEvent(new MouseEvent('click', q.init));
		}
		queued.length = 0;
	};
	if (typeof requestAnimationFrame === 'function') requestAnimationFrame(replay);
	else replay();
}

/** The island is live: fields back, focus back, clicks replayed. */
export function after_wake(
	region: Element,
	fields: FieldSnapshot[],
	active_addr: number[] | null,
	queued: QueuedClick[]
) {
	restore_fields(region, fields);
	if (active_addr) {
		const el = resolve_address(region, active_addr);
		if (el instanceof HTMLElement && document.activeElement !== el) el.focus();
	}
	const replayed = queued.length;
	replay_clicks(region, queued);
	if (DEVTOOLS)
		dt_emit({
			domain: 'runtime',
			name: 'interaction.replay',
			entry: region.getAttribute('entry') || undefined,
			fp: region.getAttribute('data-og-fp') || undefined,
			clicks: replayed,
			fields: fields.length
		});
}
