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

// KIT-WORLD PAGE THREAD (read side). On a Kit-booted (csr=true) document the ogygia runtime never
// runs, so nothing ever seeds `page_state` — a module SHARED between an island and a Kit page then
// read `data: {}` through the shims, and a real app's `page.data._locale.toLowerCase()` in onMount
// threw inside Kit's synchronous hydrate flush, killing every mount after it (the bcms all-products
// outage). The fix is a thread between the two worlds: two lines appended to Kit's generated client
// app entry (see KIT_PAGE_THREAD in vite/index.ts) publish Kit's REAL reactive `page` on this
// well-known symbol, and the shims prefer it whenever it exists. Kit's entry evaluates exactly when
// Kit boots and never ships to csr=false pages — so on csr=false documents the symbol is never set
// and the seeded shim path is untouched.
export interface KitPageBridge {
	page: PageSnapshot;
	navigating: { current: unknown };
	/** Kit's real `$page` store — `$app/stores` shim subscribers delegate here so they stay
	 *  LIVE through Kit navigations (the state getters above are already live by delegation). */
	page_store?: { subscribe(run: (value: PageSnapshot) => void): () => void };
}
const KIT_PAGE_KEY = Symbol.for('ogygia.kit-page');
export function kit_bridge(): KitPageBridge | null {
	return (globalThis as unknown as Record<symbol, KitPageBridge | undefined>)[KIT_PAGE_KEY] ?? null;
}

// One instance across EVERY bundle. In production the runtime and island entries share a single
// `page-store` chunk, so a module-local `new PageState()` was already a singleton — but `vite dev`
// serves this module as two instances (the runtime imports it relatively; islands reach it through
// the `$app/state` alias, a different resolved URL), so `set_page()`/`reset_page()` from the runtime
// updated one instance while an island read the other → stale `page.url`/`params` after SPA nav
// (e.g. a sidebar's active link stuck on the old page in dev). A `globalThis` + `Symbol.for` handle
// is one instance regardless of how many times the module is evaluated. PAGE-STATE-SINGLETON.
import { foreign_hydrate } from '../current-region.js';

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

// FOREIGN PAGE READ (dev warning, fragment federation). Inside a mounted MFE island this store is
// the SHELL's: one singleton per document, seeded from the shell's page script — the MFE's own seed
// sits in its `<head>`, which the fragment boundary drops. So a read of page.data / params / route
// / form / error during that island's hydrate sees the shell's values, while the island's SSR HTML
// was rendered with the MFE's own load: it will repaint with different values (often `undefined`).
// The shell runtime marks the foreign hydrate (`set_foreign_hydrate`); this warns once per island
// entry. `page.url` / `status` / `state` stay silent — the URL is the same on both sides.
// The once-set lives on `globalThis` for the same reason `page_state` does (PAGE-STATE-SINGLETON):
// `vite dev` evaluates this module more than once per document, and a module-local set printed
// the same island twice.
const WARNED_FOREIGN_KEY = Symbol.for('ogygia.foreign-page-warned');
const warned_foreign_entries: Set<string> = ((
	globalThis as unknown as Record<symbol, Set<string> | undefined>
)[WARNED_FOREIGN_KEY] ??= new Set<string>());
export function warn_foreign_page_read(expr: string): void {
	if (!import.meta.env.DEV) return;
	const f = foreign_hydrate();
	if (!f || warned_foreign_entries.has(f.entry)) return;
	warned_foreign_entries.add(f.entry);
	console.warn(
		`[ogygia] ${expr} was read inside a mounted MFE island (${f.entry}, from ${f.origin}).\n` +
			`In the browser this is the SHELL's page, not the MFE's. The HTML you see was rendered with ` +
			`the MFE's own load data, so this island will repaint with different values after hydrate.\n` +
			`Pass the value as a prop, or read it with a remote function.`
	);
}
