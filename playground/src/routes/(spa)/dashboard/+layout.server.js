import { currentUser, statusCounts } from '$lib/server/db.js';

// Rich, non-trivial load data: a Date, a Map, nested objects — all devalue-serialized
// into the page and available to islands via the page shim.
export function load() {
	return {
		user: currentUser(),
		navCounts: statusCounts()
	};
}
