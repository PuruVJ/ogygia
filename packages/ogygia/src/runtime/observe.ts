/**
 * ONE IntersectionObserver per distinct `rootMargin`, shared by every element that wants to know
 * when it enters the viewport — `wake:'visible'` islands, `when="visible"` holes, the hydration
 * scheduler's viewport snapshot. An observer per island (150 of them on a measured page) is 150
 * observers the browser walks on every scroll; one per margin is a handful, each walking the same
 * targets in one pass. Callbacks live on a per-observer `WeakMap` keyed by the target, so a
 * disconnected element drops out with its callback.
 */
type Callback = (intersecting: boolean) => void;
type Shared = { io: IntersectionObserver; callbacks: WeakMap<Element, Callback> };

const observers = new Map<string, Shared>();

function shared(rootMargin: string): Shared {
	let s = observers.get(rootMargin);
	if (!s) {
		const callbacks = new WeakMap<Element, Callback>();
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
			},
			{ rootMargin }
		);
		s = { io, callbacks };
		observers.set(rootMargin, s);
	}
	return s;
}

/**
 * Observe `el` under the shared observer for `rootMargin`; `cb` sees every intersection change
 * (the initial one included) until the returned unobserve is called. One callback per element per
 * margin — a second `observe` of the same element replaces the first.
 */
export function observe(el: Element, rootMargin: string, cb: Callback): () => void {
	const s = shared(rootMargin);
	s.callbacks.set(el, cb);
	s.io.observe(el);
	return () => {
		if (s.callbacks.get(el) !== cb) return; // replaced by a later observe — not ours to drop
		s.callbacks.delete(el);
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
