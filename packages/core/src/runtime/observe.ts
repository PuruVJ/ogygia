/**
 * ONE IntersectionObserver per distinct `rootMargin`, shared by every element that wants to know
 * when it enters the viewport — `wake:'visible'` islands, `when="visible"` holes, the hydration
 * scheduler's viewport snapshot. An observer per island (150 of them on a measured page) is 150
 * observers the browser walks on every scroll; one per margin is a handful, each walking the same
 * targets in one pass. Callbacks live on a per-observer `WeakMap` keyed by the target, so a
 * disconnected element drops out with its callbacks.
 *
 * SEVERAL callbacks per element per margin. It was one, a second `observe` replacing the first —
 * and the hydration scheduler's viewport snapshot and a `wake:'visible'` island both watch the
 * island at the default margin: the wake replaced the snapshot, so the scheduler never learned
 * where a visible island was and held every one of them for its whole 48 ms snapshot wait (200
 * islands scrolled into view: each woke 62–84 ms late, with nothing ahead of it).
 */
type Callback = (intersecting: boolean) => void;
type Shared = { io: IntersectionObserver; callbacks: WeakMap<Element, Set<Callback>>; last: WeakMap<Element, boolean> };

const observers = new Map<string, Shared>();

function shared(rootMargin: string): Shared {
	let s = observers.get(rootMargin);
	if (!s) {
		const callbacks = new WeakMap<Element, Set<Callback>>();
		const last = new WeakMap<Element, boolean>();
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					last.set(e.target, e.isIntersecting);
					const set = callbacks.get(e.target);
					if (set) for (const cb of [...set]) cb(e.isIntersecting);
				}
			},
			{ rootMargin }
		);
		s = { io, callbacks, last };
		observers.set(rootMargin, s);
	}
	return s;
}

/**
 * Observe `el` under the shared observer for `rootMargin`; `cb` sees every intersection change
 * (the initial one included) until the returned unobserve is called. Any number of callbacks per
 * element: a later one gets the element's last known state at once (the browser reports an
 * element it already watches only on a change), or the first report with the others.
 */
export function observe(el: Element, rootMargin: string, cb: Callback): () => void {
	const s = shared(rootMargin);
	let set = s.callbacks.get(el);
	if (!set) s.callbacks.set(el, (set = new Set()));
	const first = set.size === 0;
	set.add(cb);
	if (first) s.io.observe(el);
	else if (s.last.has(el)) {
		const state = s.last.get(el)!;
		queueMicrotask(() => {
			if (s.callbacks.get(el)?.has(cb)) cb(state);
		});
	}
	return () => {
		const now = s.callbacks.get(el);
		if (!now?.delete(cb) || now.size) return;
		s.callbacks.delete(el);
		s.last.delete(el);
		s.io.unobserve(el);
	};
}

/** Test seam: how many observers exist (one per distinct rootMargin, ever). */
export function observer_count(): number {
	return observers.size;
}

/** Observe until the FIRST time `el` intersects, then fire once and stop. */
export function once_visible(el: Element, rootMargin: string, fire: () => void): () => void {
	const stop = observe(el, rootMargin, (intersecting) => {
		if (!intersecting) return;
		stop();
		fire();
	});
	return stop;
}
