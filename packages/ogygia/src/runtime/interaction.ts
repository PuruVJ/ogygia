/**
 * `hydrate: 'interaction'` — the island sleeps until someone actually uses it, and the interaction
 * that woke it is not lost.
 *
 * WAKE (capture-phase): `pointerdown` | `keydown` | `focusin` | `click`. The first of these starts
 * hydration. WARM (not a wake): the pointer moving over the region prefetches the island module, so
 * by the time the press lands the chunk is usually cached and the wake is one microtask.
 *
 * DELEGATED: the listeners live on the DOCUMENT, once — five per armed island used to be five
 * hundred on a page of interaction islands. An event resolves to the nearest ARMED region above its
 * target (`closest`, walking up past nested regions that are not armed) and that region's state
 * handles it exactly as its own capture listener did.
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
 *
 * The capture (this module) is what must run synchronously inside the first event. The RESTORE +
 * REPLAY half (./interaction-replay.ts) is only needed once an island has woken, so it loads when
 * the first region arms — off the boot path, ahead of the first wake.
 */

import { slots } from './slots.js';
import { warm_island_module } from './region-endpoint-url.js';

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
const ARMED_SELECTOR = 'ogygia-region[wake="interaction"]';

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

export type FieldSnapshot = {
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

export type QueuedClick = {
	addr: number[];
	/** The deepest node of the click's composed path when it lies INSIDE a web component's shadow
	 *  tree (a design-system button's inner <button>): a host-level replay never reaches the shadow-internal
	 *  handler that actually toggles the component, so the replay lands here instead. */
	deep: EventTarget | null;
	tag: string;
	init: MouseEventInit;
};

/** One armed region's state — what its own capture listeners used to close over. */
type Armed = {
	region: Element;
	warm: () => void;
	fire: () => Promise<void> | void;
	woken: boolean;
	warmed: boolean;
	queued: QueuedClick[];
};

const armed = new Map<Element, Armed>();
let installed = false;

/** THE REPLAY HALF, loaded once, when the first region arms. */
type Replay = typeof import('./interaction-replay.js');
let replay_promise: Promise<Replay> | null = null;
function replay(): Promise<Replay> {
	// Link what the replay chunk uses from this module right where the chunk is loaded, so whoever
	// loads it (the feature's arm, or a direct `arm_interaction`) has linked it (./slots.ts `BootLink`).
	slots.interaction_link ??= { resolve_address };
	return (replay_promise ??= import('./interaction-replay.js'));
}

/** The nearest ARMED region above an event's target (past nested regions that are not armed). */
function armed_region_of(target: EventTarget | null): Armed | null {
	let el = target instanceof Element ? target.closest(ARMED_SELECTOR) : null;
	while (el) {
		const a = armed.get(el);
		if (a) return a;
		el = el.parentElement?.closest(ARMED_SELECTOR) ?? null;
	}
	return null;
}

function on_wake_event(e: Event): void {
	if (armed.size === 0) return;
	const a = armed_region_of(e.target);
	if (a) wake(a, e);
}

/** `pointerover` bubbles (unlike `pointerenter`) — the pointer crossing INTO an armed region, from
 *  any descendant, warms its module once. */
function on_warm_event(e: Event): void {
	if (armed.size === 0) return;
	const a = armed_region_of(e.target);
	if (!a || a.warmed) return;
	a.warmed = true;
	a.warm();
}

function install_listeners(): void {
	if (installed) return;
	installed = true;
	for (const type of WAKE_EVENTS) document.addEventListener(type, on_wake_event, { capture: true });
	document.addEventListener('pointerover', on_warm_event, { capture: true, passive: true });
}

function wake(a: Armed, e: Event): void {
	const { region, queued } = a;
	// While waking (and before), clicks are canceled + queued: their activation happens once,
	// on the replay, when the island's handlers exist. Everything else passes through natively.
	if (e.type === 'click' && e.target instanceof Element) {
		const addr = element_address(region, e.target);
		if (addr) {
			const me = e as MouseEvent;
			e.preventDefault();
			// `e.target` is already retargeted to the shadow HOST; keep the real deepest node too.
			const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
			const deep = path.length && path[0] !== e.target ? path[0] : null;
			queued.push({
				addr,
				deep,
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
	if (a.woken) return;
	a.woken = true;

	// Typed-so-far values + focus, captured as ADDRESSES (hydration may replace the nodes).
	const fields = snapshot_fields(region);
	const active = document.activeElement;
	const active_addr =
		active instanceof Element && region.contains(active) ? element_address(region, active) : null;

	const disarm = () => armed.delete(region);
	Promise.all([replay(), Promise.resolve(a.fire())]).then(
		([r]) => {
			disarm();
			r.after_wake(region, fields, active_addr, queued);
		},
		(err) => {
			// Hydration FAILED (chunk 404, network drop). Disarm so the region stops canceling
			// clicks — native behavior (links, form posts, checkboxes) must keep working on the
			// dead-but-real HTML. Replay the swallowed clicks so the failed one still acts.
			disarm();
			replay().then((r) => r.replay_clicks(region, queued));
			console.error('[ogygia] interaction island failed to hydrate — leaving it static.', err);
		}
	);
}

/**
 * Arm a cold `wake="interaction"` region.
 *
 * @param region the `<ogygia-region>` element
 * @param warm   prefetch the island module (no hydrate) — wired to the pointer entering the region
 * @param fire   begin hydration; resolves when the island is live
 * @returns disarm() — forget the region (disconnected before any interaction)
 */
export function arm_interaction(
	region: Element,
	warm: () => void,
	fire: () => Promise<void> | void
): () => void {
	armed.set(region, { region, warm, fire, woken: false, warmed: false, queued: [] });
	install_listeners();
	void replay(); // ahead of the first wake, off the boot path
	return () => {
		armed.delete(region);
	};
}
