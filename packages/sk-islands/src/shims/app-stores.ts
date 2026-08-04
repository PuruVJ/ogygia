// Client-side shim for `$app/stores` ($page/$navigating) inside islands.
// Reads the same `window.__skIslandsPage` snapshot as the `$app/state` shim.
import { page as pageState } from './app-state.js';

function snapshot() {
	return {
		url: pageState.url,
		params: pageState.params,
		route: pageState.route,
		status: pageState.status,
		data: pageState.data,
		form: pageState.form,
		error: pageState.error,
		state: pageState.state
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
