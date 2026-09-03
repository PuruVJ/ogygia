/**
 * freeze — the capture-in-flight seams. Dependency-free by design (client-safe, no cycles):
 * hooks.ts installs the readers/recorders bound to its own request bag (the ALS lives THERE);
 * region-endpoint and the `__og_source` runtime wrapper only ever call the getters.
 *
 * 1. capability grade: a render that MAY be stored must mint PRERENDER-GRADE region capabilities
 *    for its deferred/live holes (the stored HTML outlives `regionTtl`).
 * 2. source receipts: every `import.meta.og.source()`-wrapped call during such a render reports
 *    its `(id, fingerprint)` tag — the REVERSE INDEX that lets `freeze.invalidate(fn, args)`
 *    evict exactly the pages whose receipts name the doc.
 *
 * State rides ONE `globalThis` + `Symbol.for` slot — the PAGE-STATE-SINGLETON law: dist entries
 * (hooks.js, server/region-endpoint.js, freeze/source-runtime.js) can each carry their own
 * evaluation of this module, and a module-local `let` would split the seam (the installer writes
 * copy A while the mint reads copy B — regionTtl-grade holes in stored pages, silently).
 */

interface CaptureSlots {
	reader: (() => boolean) | null;
	recorder: ((tag: string) => void) | null;
	/** Federation's PROVENANCE observer: sees EVERY receipt (capture or not) so an exposed fragment
	 *  can report the sources its render consumed. One slot, installed by `federate()`. */
	observer: ((tag: string) => void) | null;
}

const SLOTS_KEY = Symbol.for('ogygia.freeze.capture');
const slots: CaptureSlots = ((globalThis as unknown as Record<symbol, CaptureSlots>)[SLOTS_KEY] ??=
	{ reader: null, recorder: null, observer: null });
// A slot created by an OLDER copy of this module (before `observer` existed) lacks the field.
slots.observer ??= null;

/** federate() installs this once — every receipt tag, capture-eligible or not. */
export function set_source_observer(fn: ((tag: string) => void) | null): void {
	slots.observer = fn;
}

/** hooks.ts installs this once — reads the per-request "freeze capture eligible" flag. */
export function set_freeze_capture_reader(fn: () => boolean): void {
	slots.reader = fn;
}

/** True while the CURRENT request's render may be stored as a frozen page. */
export function freeze_capture_active(): boolean {
	try {
		return slots.reader?.() === true;
	} catch {
		return false;
	}
}

/** hooks.ts installs this once — pushes a source receipt into the per-request bag. */
export function set_source_recorder(fn: ((tag: string) => void) | null): void {
	slots.recorder = fn;
}

/** Called by the `__og_source` wrapper on every invocation (and by a peer handle for the tags it
 *  ADOPTS from a remote fragment). The recorder is a no-op outside a capture; the observer sees
 *  every tag. */
export function record_source_read(tag: string): void {
	try {
		slots.recorder?.(tag);
	} catch {
		/* a receipt must never fail the app's own call */
	}
	try {
		slots.observer?.(tag);
	} catch {
		/* same law */
	}
}
