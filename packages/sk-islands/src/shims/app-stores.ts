// Client-side shim for `$app/stores` ($page/$navigating) inside islands.
// Reads the same `window.__ogygiaPage` snapshot as the `$app/state` shim.
import { page as page_state } from './app-state.js';

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
	subscribe(run) {
		run(snapshot());
		return () => {};
	}
};

export const navigating = {
	subscribe(run) {
		run(null);
		return () => {};
	}
};

export const updated = {
	subscribe(run) {
		run(false);
		return () => {};
	},
	check: async () => false
};
