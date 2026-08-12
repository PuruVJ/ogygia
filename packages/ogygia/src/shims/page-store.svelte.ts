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

export class PageState {
	url = $state.raw(FALLBACK.url);
	params = $state.raw<Record<string, string>>(FALLBACK.params);
	route = $state.raw<{ id: string | null }>(FALLBACK.route);
	status = $state.raw(FALLBACK.status);
	data = $state.raw<Record<string, unknown>>(FALLBACK.data);
	form = $state.raw<unknown>(FALLBACK.form);
	error = $state.raw<{ message: string } | null>(FALLBACK.error);
	state = $state.raw<Record<string, unknown>>(FALLBACK.state);

	#subscribers = new Set<() => void>();

	set(snap: Partial<PageSnapshot> | undefined | null): void {
		const s = snap || FALLBACK;
		this.url = s.url instanceof URL ? s.url : FALLBACK.url;
		this.params = s.params ?? {};
		this.route = s.route ?? { id: null };
		this.status = s.status ?? 200;
		this.data = s.data ?? {};
		this.form = s.form ?? null;
		this.error = s.error ?? null;
		this.state = s.state ?? {};
		for (const fn of this.#subscribers) {
			try {
				fn();
			} catch {
				/* ignore */
			}
		}
	}

	reset(): void {
		this.set({
			url: typeof location !== 'undefined' ? new URL(location.href) : FALLBACK.url,
			params: {},
			route: { id: null },
			status: 200,
			data: {},
			form: null,
			error: null,
			state: {}
		});
	}

	subscribe(fn: () => void): () => void {
		this.#subscribers.add(fn);
		return () => this.#subscribers.delete(fn);
	}
}

// One instance across EVERY bundle. In production the runtime and island entries share a single
// `page-store` chunk, so a module-local `new PageState()` was already a singleton — but `vite dev`
// serves this module as two instances (the runtime imports it relatively; islands reach it through
// the `$app/state` alias, a different resolved URL), so `set_page()`/`reset_page()` from the runtime
// updated one instance while an island read the other → stale `page.url`/`params` after SPA nav
// (e.g. a sidebar's active link stuck on the old page in dev). A `globalThis` + `Symbol.for` handle
// is one instance regardless of how many times the module is evaluated. PAGE-STATE-SINGLETON.
const PAGE_STATE_KEY = Symbol.for('ogygia.page-state');
const global_scope = globalThis as unknown as Record<symbol, PageState | undefined>;
export const page_state: PageState = (global_scope[PAGE_STATE_KEY] ??= new PageState());

/** Seed from an island's SSR snapshot (pre-hydration / SPA remount). */
export function set_page(snap: Partial<PageSnapshot> | undefined | null): void {
	page_state.set(snap);
}

/** Reset to location-based fallback between SPA body swaps (clears stale route data). */
export function reset_page(): void {
	page_state.reset();
}

export function subscribe_page(fn: () => void): () => void {
	return page_state.subscribe(fn);
}
