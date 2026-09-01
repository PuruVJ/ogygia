/**
 * artifacts — the capture-in-flight seams. Dependency-free by design (client-safe, no cycles):
 * hooks.ts installs the readers/recorders bound to its own request bag (the ALS lives THERE);
 * region-endpoint and the `__og_source` runtime wrapper only ever call the getters.
 *
 * 1. capability grade: a render that MAY be stored must mint PRERENDER-GRADE region capabilities
 *    for its deferred/live holes (the stored HTML outlives `regionTtl`).
 * 2. source receipts: every `import.meta.og.source()`-wrapped call during such a render reports
 *    its `(id, fingerprint)` tag — the REVERSE INDEX that lets `artifacts.invalidate(fn, args)`
 *    evict exactly the pages whose receipts name the doc.
 *
 * State rides ONE `globalThis` + `Symbol.for` slot — the PAGE-STATE-SINGLETON law: dist entries
 * (hooks.js, server/region-endpoint.js, artifacts/source-runtime.js) can each carry their own
 * evaluation of this module, and a module-local `let` would split the seam (the installer writes
 * copy A while the mint reads copy B — regionTtl-grade holes in stored pages, silently).
 */

interface CaptureSlots {
	reader: (() => boolean) | null;
	recorder: ((tag: string) => void) | null;
}

const SLOTS_KEY = Symbol.for('ogygia.artifacts.capture');
const slots: CaptureSlots = ((globalThis as unknown as Record<symbol, CaptureSlots>)[
	SLOTS_KEY
] ??= { reader: null, recorder: null });

/** hooks.ts installs this once — reads the per-request "artifact capture eligible" flag. */
export function set_artifact_capture_reader(fn: () => boolean): void {
	slots.reader = fn;
}

/** True while the CURRENT request's render may be stored as an artifact. */
export function artifact_capture_active(): boolean {
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

/** Called by the `__og_source` wrapper on every invocation; a no-op outside a capture. */
export function record_source_read(tag: string): void {
	try {
		slots.recorder?.(tag);
	} catch {
		/* a receipt must never fail the app's own call */
	}
}
