/**
 * THE HYDRATION SCHEDULER — one island per task, viewport first.
 *
 * `customElements.define` upgrades every region on the page in one task; with 21 `wake:'load'`
 * islands the old runtime then hydrated them back-to-back in microtasks — props parse + module
 * continuation + Svelte hydrate, 21 times, in ONE long task, in document order, with the header
 * nobody can see yet racing the hero everybody can. Here every island that is ready to hydrate
 * asks for a TURN; turns are handed out one per task (`scheduler.yield()`, else a `MessageChannel`
 * hop — never a timer), so the browser paints, scrolls and handles input between islands, and the
 * next turn goes to a region that intersects the viewport NOW (one shared IntersectionObserver
 * snapshot, taken at connect) before any that does not, document order within each group.
 *
 * What a turn covers is the island's whole synchronous hydrate step (props parse, Svelte hydrate,
 * lake restore). Module imports are NOT serialized — every island's `import()` starts at its wake,
 * in parallel; a turn is requested when the module has arrived. Arrivals are staggered (one task
 * each, in network order), so "viewport first" also means: a ready island BELOW the fold holds its
 * turn while a viewport island is still waiting for its module — bounded, so a chunk that never
 * comes cannot stall the rest of the page.
 *
 * The viewport snapshot is asynchronous (the observer reports after layout). A drain waits for
 * the snapshot of every queued region, bounded (a hidden document never lays out; a stalled
 * observer must not stall hydration), so the boot's first island is the right one, not merely the
 * first one.
 */
import { observe } from './observe.js';

type Turn = { el: Element; order: number; queued_at: number; resolve: () => void };

/** How long the drain waits for the observer's snapshot of a queued region before ignoring it. */
const SNAPSHOT_WAIT_MS = 48;
/** How long a ready below-the-fold island holds for a viewport island still loading its module. */
const HOLD_FOR_VIEWPORT_MS = 1000;

const pending: Turn[] = [];
let draining = false;
/** Connect-order stamp per region — document order at upgrade, insertion order after a morph. */
const order_of = new WeakMap<Element, number>();
let next_order = 0;
/** The snapshot: intersecting now? Absent = the observer has not reported yet. */
const in_viewport = new WeakMap<Element, boolean>();
const unobserve_of = new WeakMap<Element, () => void>();
/** Regions whose hydrate has STARTED (module in flight) and not yet taken its turn. */
const loading = new Set<Element>();
let wait_timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Yield to the event loop: resolves in a NEW task, so whatever ran before is a finished task and
 * the browser may render and handle input in between. `scheduler.yield()` where it exists (it
 * keeps the continuation at the current task's priority); else a message hop — a `MessageChannel`
 * post lands as a task without the 4 ms clamp `setTimeout` carries.
 */
let channel: MessageChannel | null = null;
const hops: Array<() => void> = [];
export function yield_task(): Promise<void> {
	const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
	if (s && typeof s.yield === 'function') return s.yield();
	return new Promise<void>((resolve) => {
		if (!channel) {
			channel = new MessageChannel();
			channel.port1.onmessage = () => hops.shift()?.();
		}
		hops.push(resolve);
		channel.port2.postMessage(null);
	});
}

/**
 * Register a region with the scheduler at connect: stamp its order, start its viewport snapshot.
 * Cheap on purpose (a stamp and an `observe`) — connect runs for every region in one task.
 */
export function register_region(el: Element): void {
	if (!order_of.has(el)) order_of.set(el, next_order++);
	if (unobserve_of.has(el)) return;
	unobserve_of.set(
		el,
		observe(el, '0px', (intersecting) => {
			in_viewport.set(el, intersecting);
			if (pending.length) schedule_drain();
		})
	);
}

/**
 * Drop a region from the scheduler (disconnect): its snapshot stops and any pending turn is handed
 * out at once — the waiting hydrate step then sees `isConnected === false` and stands down (or, if
 * the element was re-attached meanwhile, runs — exactly what an un-scheduled wait would have done).
 */
export function unregister_region(el: Element): void {
	stop_snapshot(el);
	in_viewport.delete(el);
	loading.delete(el);
	for (let i = pending.length - 1; i >= 0; i--) {
		if (pending[i].el !== el) continue;
		const [turn] = pending.splice(i, 1);
		turn.resolve();
	}
	if (pending.length) schedule_drain();
}

function stop_snapshot(el: Element): void {
	unobserve_of.get(el)?.();
	unobserve_of.delete(el);
}

/** The island's module is in flight: a viewport island here holds ready islands below the fold. */
export function hydrate_started(el: Element): void {
	loading.add(el);
}

/** The hydrate attempt is over (turn taken, or it never got there — no entry, a failed import). */
export function hydrate_settled(el: Element): void {
	if (!loading.delete(el)) return;
	if (pending.length) schedule_drain();
}

/**
 * Wait for this region's turn. Resolves in a task of its own, after every region ahead of it in
 * priority has had its task. Call it when the island can hydrate right now (module loaded) — the
 * continuation after the `await` IS the turn: keep the whole synchronous hydrate step in it.
 */
export function hydrate_turn(el: Element): Promise<void> {
	return new Promise<void>((resolve) => {
		pending.push({
			el,
			order: order_of.get(el) ?? (order_of.set(el, next_order), next_order++),
			queued_at: now(),
			resolve
		});
		schedule_drain();
	});
}

function now(): number {
	return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function schedule_drain(): void {
	if (draining) return;
	draining = true;
	yield_task().then(drain);
}

/** Re-drain after `ms` (one timer at a time — the earliest wait wins, later ones ride it). */
function drain_after(ms: number): void {
	if (wait_timer) return;
	wait_timer = setTimeout(
		() => {
			wait_timer = null;
			schedule_drain();
		},
		Math.max(1, ms)
	);
}

/** One turn per call: pick the best pending region, hand it its task; the next pick after a yield. */
function drain(): void {
	draining = false;
	if (!pending.length) return;
	const t = now();
	const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
	// Viewport-first needs the snapshot: hold the FIRST picks until every queued region has
	// reported, or its wait is up (the observer re-drains as reports arrive). A hidden document has
	// no viewport to prefer — skip the wait there.
	if (!hidden) {
		for (const p of pending) {
			if (in_viewport.has(p.el)) continue;
			const left = SNAPSHOT_WAIT_MS - (t - p.queued_at);
			if (left > 0) return drain_after(left);
		}
	}
	let best = 0;
	for (let i = 1; i < pending.length; i++) {
		const a = pending[best];
		const b = pending[i];
		const va = in_viewport.get(a.el) === true;
		const vb = in_viewport.get(b.el) === true;
		if (vb !== va ? vb : b.order < a.order) best = i;
	}
	const turn = pending[best];
	// The best ready island is below the fold while a viewport island is still waiting for its
	// module: hold — that island's turn request (or its settling) re-drains. Bounded, so a chunk
	// that never arrives cannot stall the page.
	if (!hidden && in_viewport.get(turn.el) !== true) {
		const left = HOLD_FOR_VIEWPORT_MS - (t - turn.queued_at);
		if (left > 0) {
			for (const el of loading) {
				if (in_viewport.get(el) === true) return drain_after(left);
			}
		}
	}
	pending.splice(best, 1);
	loading.delete(turn.el);
	stop_snapshot(turn.el);
	turn.resolve(); // the island's hydrate step runs as this task's microtask continuation
	if (pending.length) schedule_drain(); // the next island in the next task
}

/** Test seam: is a hydration turn queued or being drained right now? */
export function schedule_idle(): boolean {
	return pending.length === 0 && !draining;
}
