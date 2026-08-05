// Shared page store for `$app/state` + `$app/stores` island shims.
//
// Module singleton (runtime + shims share one client chunk). Fields are `$state.raw` like Kit —
// deep `$state` breaks `URL` (and Date/Map in `data`). Runtime converts the devalue href string
// to a `URL` before `set_page`; we only guard non-URL leftovers.

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

class PageState {
	url = $state.raw(FALLBACK.url);
	params = $state.raw<Record<string, string>>(FALLBACK.params);
	route = $state.raw<{ id: string | null }>(FALLBACK.route);
	status = $state.raw(FALLBACK.status);
	data = $state.raw<Record<string, unknown>>(FALLBACK.data);
	form = $state.raw<unknown>(FALLBACK.form);
	error = $state.raw<{ message: string } | null>(FALLBACK.error);
	state = $state.raw<Record<string, unknown>>(FALLBACK.state);
}

export const page_state = new PageState();

const subscribers = new Set<() => void>();

/** Seed from an island's SSR snapshot (pre-hydration / SPA remount). */
export function set_page(snap: Partial<PageSnapshot> | undefined | null): void {
	const s = snap || FALLBACK;
	page_state.url = s.url instanceof URL ? s.url : FALLBACK.url;
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
			/* ignore */
		}
	}
}

export function subscribe_page(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}
