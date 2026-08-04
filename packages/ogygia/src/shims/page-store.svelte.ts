// Shared, $state-backed page store for the `$app/state` + `$app/stores` island shims.
//
// The runtime (producer) and the shims (consumers) are emitted into the SAME consumer client
// build, so rollup dedupes this module into one shared chunk: a genuine module-scoped singleton.
// That lets us drop the old `window.__ogygiaPage` global entirely — the runtime imports
// `set_page` and the shims read `page_state` directly, all against the same proxy instance.
//
// `page_state` is a deep reactive proxy, so `$derived` / `$effect` over `page.url` / `page.data`
// in an island track and re-run exactly like Kit's real reactive `page`. The runtime calls
// `set_page` before hydrating each island — on the initial load and after every SPA nav — so a
// freshly-mounted island always derives from the current page.

export interface PageSnapshot {
	url: URL;
	params: Record<string, string>;
	route: { id: string | null };
	status: number;
	data: Record<string, unknown>;
	form: unknown;
	error: { message: string } | null;
	state: Record<string, unknown>;
}

const FALLBACK: PageSnapshot = {
	url: typeof location !== 'undefined' ? new URL(location.href) : new URL('http://localhost/'),
	params: {},
	route: { id: null },
	status: 200,
	data: {},
	form: null,
	error: null,
	state: {}
};

export const page_state = $state<PageSnapshot>({ ...FALLBACK });

// Legacy `$app/stores` subscribers (module-scoped, not a global). `set_page` re-runs them so
// `$page` fires on every navigation the way Kit's store does.
const subscribers = new Set<() => void>();

/** Seed the reactive page from an island's SSR snapshot. Called by the runtime pre-hydration. */
export function set_page(snap: Partial<PageSnapshot> | undefined | null): void {
	const s = snap || FALLBACK;
	page_state.url = (s.url as URL) ?? FALLBACK.url;
	page_state.params = s.params ?? {};
	page_state.route = s.route ?? { id: null };
	page_state.status = s.status ?? 200;
	page_state.data = s.data ?? {};
	page_state.form = s.form ?? null;
	page_state.error = s.error ?? null;
	page_state.state = s.state ?? {};
	for (const fn of subscribers) {
		try {
			fn();
		} catch {
			/* a broken subscriber must not block others */
		}
	}
}

/** Register a `$app/stores` subscriber; returns an unsubscribe. */
export function subscribe_page(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}
