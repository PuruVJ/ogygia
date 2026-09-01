// Client `$app/state` shim for islands (`csr=false` → Kit page is uninitialized).
// Reads the shared `$state.raw` page store (see `page-store.svelte.ts`) — except on a Kit-booted
// document, where the kit-page bridge hands us Kit's REAL reactive `page` (shared modules on
// csr=true pages must see Kit's truth; the island store is never seeded there).

import { page_state, kit_bridge } from './page-store.svelte.js';

export type { PageSnapshot } from './page-store.svelte.js';

export const page = {
	get url() {
		return kit_bridge()?.page.url ?? page_state.url;
	},
	get params() {
		return kit_bridge()?.page.params ?? page_state.params;
	},
	get route() {
		return kit_bridge()?.page.route ?? page_state.route;
	},
	get status() {
		return kit_bridge()?.page.status ?? page_state.status;
	},
	get data() {
		return kit_bridge()?.page.data ?? page_state.data;
	},
	get form() {
		const b = kit_bridge();
		if (b) return b.page.form ?? null;
		return page_state.form ?? null;
	},
	get error() {
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
