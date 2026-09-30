/**
 * THE HUB'S WATCH CHANNEL (hub v2, phases W and B) — split out of ref.ts so the boot, which needs only
 * "subscribe to an id / tell its watchers" (runtime/frame-store.ts: region frames), never carries the
 * whole identity hub. ref.ts re-exports all of it: one channel either way.
 *
 * WATCH — subscribe to fresh data settling for a hub id. THE one subscription primitive: region
 * frames, streamed page-data, live refresh — every "a value arrives later for this identity" channel
 * routes through here instead of owning its own subscriber set. Browser-only in practice (the
 * request-scoped server never re-settles an id within one render).
 */

type Watcher = (live: unknown) => void;

/** id → callbacks. One per realm (a second bundle evaluating this module shares it). */
const WATCHERS_KEY = Symbol.for('ogygia.hub.watchers');
export function watchers(): Map<string, Set<Watcher>> {
	const g = globalThis as Record<symbol, unknown>;
	return ((g[WATCHERS_KEY] as Map<string, Set<Watcher>> | undefined) ??= new Map());
}

/** Subscribe to fresh data settling for `id`. Returns an unsubscribe fn. */
export function watch(id: string, cb: Watcher): () => void {
	const all = watchers();
	let set = all.get(id);
	if (set === undefined) all.set(id, (set = new Set()));
	set.add(cb);
	return () => {
		const s = all.get(id);
		if (s === undefined) return;
		s.delete(cb);
		if (s.size === 0) all.delete(id);
	};
}

/**
 * Notify watchers that fresh data settled for `id`. Called by resolve's live-merge path AND
 * directly by subsystems that push a value in (a region frame landing, a streamed promise
 * resolving) — those pass the settled value; resolve's path passes the merged live instance.
 * A throwing watcher never blocks the others.
 */
export function notify(id: string, live: unknown): void {
	// During a batch (phase B), buffer instead of firing — a later id overwrites an earlier one,
	// so each watched id notifies at most once, with its FINAL value, after the whole batch decodes.
	if (batch_depth > 0) {
		(batch_pending ??= new Map()).set(id, live);
		return;
	}
	notify_now(id, live);
}

function notify_now(id: string, live: unknown): void {
	const set = watchers().get(id);
	if (set === undefined) return;
	for (const cb of [...set]) {
		try {
			cb(live);
		} catch {
			/* one watcher's throw must not starve the rest */
		}
	}
}

// ── batch (phase B): resolve a bag of refs as ONE transaction — decode everything, THEN notify.
// Without this, resolving refs one-by-one lets a watcher fire between two merges and observe a
// torn cross-ref state (cart merged, user not yet). Reentrant via a depth counter.
let batch_depth = 0;
let batch_pending: Map<string, unknown> | null = null;

/**
 * Run `fn` with watch notifications BUFFERED, flushing them once when the outermost batch exits.
 * Wrap any operation that resolves several refs at once (a context parse, a props decode, a nav's
 * ref bag) so cross-ref invariants hold before any watcher reacts. Returns `fn`'s result.
 */
export function batch<T>(fn: () => T): T {
	batch_depth++;
	try {
		return fn();
	} finally {
		batch_depth--;
		if (batch_depth === 0) {
			const pending = batch_pending;
			batch_pending = null;
			if (pending !== undefined && pending !== null) {
				for (const [id, live] of pending) notify_now(id, live);
			}
		}
	}
}

/** How many watchers are registered for `id` — lets a subsystem that owns lifecycle around a
 *  hub id (fetch dedupe, eviction TTL) make refcount decisions without a parallel subscriber set. */
export function watcher_count(id: string): number {
	return watchers().get(id)?.size ?? 0;
}
