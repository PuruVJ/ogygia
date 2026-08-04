// Client-side shim for `$app/stores` ($page/$navigating) inside islands.
// Derives from the same shared $state-backed page store as `$app/state`, and re-runs each
// subscriber via the store's module-scoped subscriber set so `$page` updates after SPA navs.
import { page_state, subscribe_page } from './page-store.svelte.js';

function snapshot() {
	return {
		url: page_state.url,
		params: page_state.params,
		route: page_state.route,
		status: page_state.status,
		data: page_state.data,
		form: page_state.form,
		error: page_state.error,
		state: page_state.state
	};
}

export const page = {
	subscribe(run: (value: ReturnType<typeof snapshot>) => void) {
		run(snapshot());
		return subscribe_page(() => run(snapshot()));
	}
};

export const navigating = {
	subscribe(run: (value: null) => void) {
		run(null);
		return () => {};
	}
};

export const updated = {
	subscribe(run: (value: boolean) => void) {
		run(false);
		return () => {};
	},
	check: async () => false
};
