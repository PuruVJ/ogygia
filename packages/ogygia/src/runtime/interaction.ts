/**
 * `hydrate: 'interaction'` — the island sleeps until someone actually uses it, and the interaction
 * that woke it is not lost.
 *
 * WAKE (capture-phase, on the region): `pointerdown` | `keydown` | `focusin` | `click`. The first
 * of these starts hydration. WARM (not a wake): `pointerenter` prefetches the island module, so by
 * the time the press lands the chunk is usually cached and the wake is one microtask.
 *
 * HYDRATION REPLACES NODES. Svelte's hydrate pass may recreate the region's DOM, so nothing
 * captured before the wake can be replayed/restored by node reference — the original elements are
 * disconnected afterwards. Everything below is therefore re-resolved POSITIONALLY: an element is
 * recorded as its child-index path from the region ("address"), and after hydration the element
 * now sitting at that address receives the replay/restore. The hydrated markup mirrors the SSR
 * markup (same component, same props), so addresses stay valid; a tag-name check guards drift.
 *
 * WHAT SURVIVES THE WAKE:
 * - **Clicks are queued + replayed.** While waking, `click` events are `preventDefault()`ed and
 *   recorded (address + coordinates); after hydration each re-dispatches at its address. Cancel-
 *   then-replay means a checkbox / link / summary activates exactly ONCE — on the replay, where
 *   the island's handlers exist. Enter/Space activation arrives as a derived click → same path.
 * - **Typing lands natively and is restored.** Characters are in the DOM before hydration starts;
 *   hydration resets `.value` from SSR state, so field values (+ checkedness + selection) are
 *   snapshotted at wake and re-applied at the field's address, with `input`/`change` events so
 *   `bind:` syncs. Keydowns are never synthetically replayed (untrusted keys produce no text).
 * - **Focus is restored** at the focused element's address.
 *
 * Replayed events are NOT trusted user gestures (`event.isTrusted === false`): `window.open`,
 * clipboard, fullscreen from the first interaction will be blocked by the browser. Components can
 * detect the situation via `hydratedBy() === 'interaction'`.
 */

import { slots } from './slots.js';
import { warm_island_module } from './region-endpoint-url.js';
import { emit as dt_emit } from '../devtools/bus.js';

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

/** Feature entry: fill the `interaction` slot — wake a cold island on first use, warm on hover. */
export function install() {
	slots.interaction = (el, fire) => {
		const warm = () => {
			const entry = el.getAttribute('entry');
			if (entry) warm_island_module(entry);
		};
		return arm_interaction(el, warm, () => Promise.resolve(fire()));
	};
}

const WAKE_EVENTS = ['pointerdown', 'keydown', 'focusin', 'click'] as const;

/** Form controls whose typed value must survive hydration. */
const VALUE_SELECTOR = 'input, textarea, select';

/** Child-index path from `region` down to `el` — survives node replacement by position. */
export function element_address(region: Element, el: Element): number[] | null {
	const addr: number[] = [];
	let node: Element = el;
	while (node !== region) {
		const parent = node.parentElement;
		if (!parent) return null;
		addr.unshift(Array.prototype.indexOf.call(parent.children, node));
		node = parent;
	}
	return addr;
}

/** The element now sitting at `addr` under `region` (post-hydration), or null. */
export function resolve_address(region: Element, addr: number[]): Element | null {
	let node: Element = region;
	for (const i of addr) {
		const next = node.children[i];
		if (!next) return null;
		node = next;
	}
	return node;
}

type FieldSnapshot = {
	/** The PRE-hydration node. Values are read from it AT RESTORE TIME: the wake fires on the very
	 * first keydown — BEFORE that key's character has landed — and more keystrokes land in this
	 * node while the island loads. A detached node keeps its `.value`, so at restore it holds
	 * everything the user typed up to the moment hydration swapped it out. */
	el: HTMLInputElement;
	addr: number[];
	tag: string;
};

function snapshot_fields(region: Element): FieldSnapshot[] {
	const out: FieldSnapshot[] = [];
	for (const el of region.querySelectorAll(VALUE_SELECTOR)) {
		const addr = element_address(region, el);
		if (!addr) continue;
		out.push({ el: el as HTMLInputElement, addr, tag: el.tagName });
	}
	return out;
}

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

type QueuedClick = {
	addr: number[];
	tag: string;
	init: MouseEventInit;
};

/**
 * Arm a cold `wake="interaction"` region.
 *
 * @param region the `<ogygia-region>` element
 * @param warm   prefetch the island module (no hydrate) — wired to `pointerenter`
 * @param fire   begin hydration; resolves when the island is live
 * @returns disarm() — remove every listener (region disconnected before any interaction)
 */
export function arm_interaction(
	region: Element,
	warm: () => void,
	fire: () => Promise<void> | void
): () => void {
	let woken = false;
	const queued: QueuedClick[] = [];

	const on_event = (e: Event) => {
		// While waking (and before), clicks are canceled + queued: their activation happens once,
		// on the replay, when the island's handlers exist. Everything else passes through natively.
		if (e.type === 'click' && e.target instanceof Element) {
			const addr = element_address(region, e.target);
			if (addr) {
				const me = e as MouseEvent;
				e.preventDefault();
				queued.push({
					addr,
					tag: e.target.tagName,
					init: {
						bubbles: true,
						cancelable: true,
						composed: true,
						clientX: me.clientX,
						clientY: me.clientY,
						button: me.button,
						ctrlKey: me.ctrlKey,
						metaKey: me.metaKey,
						shiftKey: me.shiftKey,
						altKey: me.altKey,
						detail: me.detail
					}
				});
			}
		}
		if (woken) return;
		woken = true;

		// Typed-so-far values + focus, captured as ADDRESSES (hydration may replace the nodes).
		const fields = snapshot_fields(region);
		const active = document.activeElement;
		const active_addr =
			active instanceof Element && region.contains(active) ? element_address(region, active) : null;

		Promise.resolve(fire()).then(
			() => {
				disarm();
				restore_fields(region, fields);
				if (active_addr) {
					const el = resolve_address(region, active_addr);
					if (el instanceof HTMLElement && document.activeElement !== el) el.focus();
				}
				// Replay in arrival order at each click's address (tag-checked against drift).
				const replayed = queued.length;
				for (const q of queued) {
					const t = resolve_address(region, q.addr);
					if (!t || t.tagName !== q.tag) continue;
					t.dispatchEvent(new MouseEvent('click', q.init));
				}
				queued.length = 0;
				if (DEVTOOLS)
					dt_emit({
						domain: 'runtime',
						name: 'interaction.replay',
						entry: region.getAttribute('entry') || undefined,
						fp: region.getAttribute('data-og-fp') || undefined,
						clicks: replayed,
						fields: fields.length
					});
			},
			(err) => {
				// Hydration FAILED (chunk 404, network drop). Disarm so the region stops canceling
				// clicks — native behavior (links, form posts, checkboxes) must keep working on the
				// dead-but-real HTML. Replay the swallowed clicks so the failed one still acts.
				disarm();
				for (const q of queued) {
					const t = resolve_address(region, q.addr);
					if (!t || t.tagName !== q.tag) continue;
					t.dispatchEvent(new MouseEvent('click', q.init));
				}
				queued.length = 0;
				console.error('[ogygia] interaction island failed to hydrate — leaving it static.', err);
			}
		);
	};

	const listeners: Array<[string, EventListener]> = [];
	for (const type of WAKE_EVENTS) {
		const l = on_event as EventListener;
		region.addEventListener(type, l, { capture: true });
		listeners.push([type, l]);
	}
	const on_warm = () => warm();
	region.addEventListener('pointerenter', on_warm, { once: true });
	listeners.push(['pointerenter', on_warm]);

	const disarm = () => {
		for (const [type, l] of listeners) {
			region.removeEventListener(type, l, { capture: type !== 'pointerenter' });
		}
	};
	return disarm;
}
