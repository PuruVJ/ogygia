// Client `$app/state` shim for islands (`csr=false` → Kit page is uninitialized).
// Reads the shared `$state.raw` page store (see `page-store.svelte.ts`) — except on a Kit-booted
// document, where the kit-page bridge hands us Kit's REAL reactive `page` (shared modules on
// csr=true pages must see Kit's truth; the island store is never seeded there).

import { page_state, kit_bridge, warn_foreign_page_read } from './page-store.svelte.js';

export type { PageSnapshot } from './page-store.svelte.js';

// The per-page fields warn (dev) when read inside a mounted MFE island — see
// `warn_foreign_page_read`. `url` / `status` / `state` do not: they are the same on both sides.
export const page = {
	get url() {
		return kit_bridge()?.page.url ?? page_state.url;
	},
	get params() {
		warn_foreign_page_read('page.params');
		return kit_bridge()?.page.params ?? page_state.params;
	},
	get route() {
		warn_foreign_page_read('page.route');
		return kit_bridge()?.page.route ?? page_state.route;
	},
	get status() {
		return kit_bridge()?.page.status ?? page_state.status;
	},
	get data() {
		warn_foreign_page_read('page.data');
		return kit_bridge()?.page.data ?? page_state.data;
	},
	get form() {
		warn_foreign_page_read('page.form');
		const b = kit_bridge();
		if (b) return b.page.form ?? null;
		return page_state.form ?? null;
	},
	get error() {
		warn_foreign_page_read('page.error');
		const b = kit_bridge();
		if (b) return b.page.error ?? null;
		return page_state.error ?? null;
	},
	get state() {
		const b = kit_bridge();
		if (b) return b.page.state ?? {};
		return page_state.state ?? {};
	}
};

export const navigating = {
	get current() {
		return kit_bridge()?.navigating.current ?? null;
	}
};
export const updated = {
	get current() {
		return false;
	},
	check: async () => false
};
