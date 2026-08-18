// ─────────────────────────────────────────────────────────────────────────────
// The frame store — the ONLY meeting point between the network and region DOM.
//
// Invariant (see internal/notes/frames.md): no code path from network arrival to DOM. Every channel
// (defer fetch, streamed parcel, mutation fragment, live refresh) WRITES a frame here; region
// elements are BINDERS that subscribe to their address and apply store state to themselves.
//
// What the mechanics buy:
//   • dedupe   — N regions with the same address share one in-flight fetch (`ensure`).
//   • staleness — versions are ticketed at REQUEST time; `write` drops v <= applied, so a slow
//     response that started earlier can never overwrite one that started later.
//   • safety   — a prefetch warms an address nothing is bound to; it cannot touch the wrong DOM.
//   • lifecycle — the shared fetch aborts only when the LAST waiter abandons; entries evict on a
//     TTL after the last subscriber unbinds.
//
// Pure module: no DOM, no Svelte, no globals beyond timers. Unit-tested in test/frame-store.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
import type { Frame } from '../frame.js';

export type FrameFetcher = (signal: AbortSignal) => Promise<string>;

type Inflight = {
	ticket: number;
	promise: Promise<string>;
	controller: AbortController;
	/** ensure() callers currently awaiting; last abandon() aborts. */
	waiters: number;
	/**
	 * Set ONLY for a reservation (an address whose content is arriving via an external batch stream,
	 * not a fetch this store started). `write()` calls `settle` when the frame lands; `release()` calls
	 * `fail` when the batch ends without one. Absent for a real fetch inflight.
	 */
	settle?: (html: string) => void;
	fail?: (err: unknown) => void;
};

type Entry = {
	/** Version of the applied content (0 = nothing applied yet). */
	v: number;
	html: string | null;
	/** Monotonic ticket source — every fetch START takes the next ticket. */
	seq: number;
	inflight: Inflight | null;
	subs: Set<(f: Frame) => void>;
	evict: ReturnType<typeof setTimeout> | null;
};

/** Entries with no subscribers linger this long (ms) so quick remounts / SPA swaps reuse content. */
const EVICT_TTL = 60_000;

// ONE store per document, even when this module is duplicated across bundles. The transport hook
// (decode → write) ships in the app's UNIVERSAL hooks graph, while the region binder (subscribe) ships
// in the separately-loaded ogygia RUNTIME chunk — two module instances. A single-flight mutation
// writes in the transport copy and must notify a subscriber registered in the runtime copy, so the
// `entries` map is pinned to a global. Falls back to a plain Map off-DOM (SSR / unit tests).
const GLOBAL_KEY = '__ogygia_frames__';
const store_host = (typeof globalThis !== 'undefined' ? globalThis : {}) as Record<
	string,
	Map<string, Entry> | undefined
>;
const entries: Map<string, Entry> = store_host[GLOBAL_KEY] ?? (store_host[GLOBAL_KEY] = new Map());

function entry(a: string): Entry {
	let e = entries.get(a);
	if (!e) {
		e = { v: 0, html: null, seq: 0, inflight: null, subs: new Set(), evict: null };
		entries.set(a, e);
	}
	return e;
}

/**
 * Let an idle entry (no subscribers, no in-flight fetch) linger EVICT_TTL, then drop it. A late binder
 * that mounts inside the window still catches its content (prefetch / batch-stream ahead of the DOM);
 * nothing bound means nothing to keep. Idempotent — resets the timer. Both channels that leave an
 * entry idle call this: a subscriber unbinding, AND a `write()` that lands where nothing is listening
 * (a single-flight mutation for an unmounted region, or a live tick whose address keeps changing).
 * Without the write path, those orphan entries would accumulate forever — they never had a subscriber
 * to trigger eviction.
 */
function schedule_evict(a: string, e: Entry): void {
	if (e.subs.size > 0 || e.inflight) return; // still live — keep it
	if (e.evict) clearTimeout(e.evict);
	e.evict = setTimeout(() => {
		const cur = entries.get(a);
		if (cur === e && cur.subs.size === 0 && !cur.inflight) entries.delete(a);
	}, EVICT_TTL);
}

/** Applied content for an address, if any. */
export function peek(a: string): { v: number; html: string } | null {
	const e = entries.get(a);
	return e && e.html != null ? { v: e.v, html: e.html } : null;
}

/** Next request ticket for an address. External channels (streaming, mutations) use this too. */
export function ticket(a: string): number {
	return ++entry(a).seq;
}

/**
 * Write a frame. Applied only if strictly newer than the current content; stale writes are
 * dropped and reported `false`. Subscribers are notified on apply.
 */
export function write(f: Frame): boolean {
	const e = entry(f.a);
	if (f.v <= e.v) return false; // stale — a newer write already landed
	if (f.v > e.seq) e.seq = f.v; // foreign ticket (streamed/mutation frame) — keep seq monotonic
	e.v = f.v;
	e.html = f.html;
	// Fulfil a batch reservation: a binder that joined via ensure() unblocks, and no per-region fetch
	// ever starts. The subscription (set in the binder) is what actually paints — settle just unblocks.
	const held = e.inflight;
	if (held?.settle) {
		e.inflight = null;
		held.settle(f.html);
	}
	for (const cb of [...e.subs]) cb(f);
	schedule_evict(f.a, e); // no-op while subscribed; arms the TTL when the write lands unbound
	return true;
}

/**
 * Reserve an address whose content is arriving via an EXTERNAL batch stream (single-flight navigation). A region
 * binder that mounts before its frame lands calls `ensure()`, sees this reservation, and JOINS it
 * instead of starting its own fetch — so a navigation that pulls N regions makes ONE batch request,
 * not N. `write()` fulfils the reservation when the frame arrives; `release()` fails it if the batch
 * ends without one (the binder then falls back to its own fetch). No-op if content or a fetch is
 * already present.
 */
export function reserve(a: string): void {
	const e = entry(a);
	if (e.html != null || e.inflight) return;
	if (e.evict) {
		clearTimeout(e.evict);
		e.evict = null;
	}
	let settle!: (html: string) => void;
	let fail!: (err: unknown) => void;
	const promise = new Promise<string>((res, rej) => {
		settle = res;
		fail = rej;
	});
	promise.catch(() => {}); // an unclaimed reservation must never surface as an unhandled rejection
	e.inflight = { ticket: ticket(a), promise, controller: new AbortController(), waiters: 0, settle, fail };
}

/**
 * Fail an unfulfilled reservation (the batch ended and no frame carried this address). Joined binders
 * reject out of `ensure()` and retry with their own fetch. No-op once content has arrived.
 */
export function release(a: string): void {
	const e = entries.get(a);
	const held = e?.inflight;
	if (!e || !held?.fail || e.html != null) return;
	e.inflight = null;
	held.fail(new Error('ogygia batch: no frame for ' + a));
	schedule_evict(a, e);
}

/**
 * Subscribe to writes at an address. If content is ALREADY applied, the callback fires immediately
 * with it (a late binder — e.g. a region that mounts after a batch stream already delivered its
 * frame — catches up without a request). Returns an unsubscribe fn. While subscribed the entry
 * never evicts; after the last unsubscribe it lingers EVICT_TTL then drops (unless re-bound).
 */
export function subscribe(a: string, cb: (f: Frame) => void): () => void {
	const e = entry(a);
	if (e.evict) {
		clearTimeout(e.evict);
		e.evict = null;
	}
	e.subs.add(cb);
	if (e.html != null) cb({ a, v: e.v, html: e.html });
	return () => {
		e.subs.delete(cb);
		schedule_evict(a, e);
	};
}

/**
 * Ensure an address has content, deduping concurrent callers onto one fetch.
 *
 * - Content already applied (and not `force`): resolves immediately with it.
 * - A fetch is in flight (and not `force`): joins it — N regions, ONE request.
 * - Otherwise starts `fetcher` with a fresh ticket; on success the response is WRITTEN (subject to
 *   the staleness check) and the resolved value is whatever the store now holds.
 * - `force` (SWR revalidate) always starts a new fetch; the ticket ordering still guarantees an
 *   older in-flight response can't overwrite it.
 *
 * Rejections propagate to every joined caller; retry policy stays with the caller (the element).
 */
export function ensure(
	a: string,
	fetcher: FrameFetcher,
	opts: { force?: boolean } = {}
): Promise<string> {
	const e = entry(a);
	if (!opts.force) {
		if (e.html != null) return Promise.resolve(e.html);
		if (e.inflight) {
			e.inflight.waiters++;
			return e.inflight.promise;
		}
	}
	const controller = new AbortController();
	const t = ticket(a);
	const inflight: Inflight = {
		ticket: t,
		controller,
		waiters: 1,
		promise: fetcher(controller.signal).then(
			(html) => {
				if (e.inflight === inflight) e.inflight = null;
				write({ a, v: t, html });
				// Resolve with the freshest applied content (a newer ticket may have raced past us).
				return e.html ?? html;
			},
			(err) => {
				if (e.inflight === inflight) e.inflight = null;
				throw err;
			}
		)
	};
	e.inflight = inflight;
	return inflight.promise;
}

/**
 * A waiter is leaving (its element disconnected). Aborts the shared fetch only when the LAST
 * waiter leaves — one unmounting element must not kill a fetch its twin still awaits.
 */
export function abandon(a: string): void {
	const e = entries.get(a);
	if (!e?.inflight) return;
	if (--e.inflight.waiters <= 0) {
		e.inflight.controller.abort();
		e.inflight = null;
	}
}

/** Test/HMR hook — drop everything. */
export function _reset(): void {
	for (const e of entries.values()) {
		if (e.evict) clearTimeout(e.evict);
		e.inflight?.fail?.(new Error('reset')); // reject any joined reservation waiters (no hung promises)
		e.inflight?.controller.abort();
	}
	entries.clear();
}
