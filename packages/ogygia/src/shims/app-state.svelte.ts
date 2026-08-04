// Client-side `$app/state` shim used INSIDE islands.
//
// Under `csr = false`, Kit's client runtime never boots, so the real `$app/state` `page`
// would be uninitialised on the client. This shim reads the shared `$state`-backed page store
// (see `page-store.svelte.ts`), so `$derived` / `$effect` over `page.url` / `page.params` /
// `page.data` behave like Kit's real reactive page instead of reading a frozen snapshot.
//
// No global is involved: the runtime and this shim share the same module singleton (they land
// in one consumer client build). Aliased only in the CLIENT build; SSR keeps the real
// `$app/state`.

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
