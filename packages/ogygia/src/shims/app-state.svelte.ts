// Client `$app/state` shim for islands (`csr=false` → Kit page is uninitialized).
// Reads the shared `$state.raw` page store (see `page-store.svelte.ts`).

import { page_state } from './page-store.svelte.js';

export type { PageSnapshot } from './page-store.svelte.js';

export const page = {
	get url() {
		return page_state.url;
	},
	get params() {
		return page_state.params;
	},
	get route() {
		return page_state.route;
	},
	get status() {
		return page_state.status;
	},
	get data() {
		return page_state.data;
	},
	get form() {
		return page_state.form ?? null;
	},
	get error() {
		return page_state.error ?? null;
	},
	get state() {
		return page_state.state ?? {};
	}
};

export const navigating = {
	get current() {
		return null;
	}
};
export const updated = {
	get current() {
		return false;
	},
	check: async () => false
};
