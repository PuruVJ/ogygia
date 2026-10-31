import { currentUser, statusCounts } from '$lib/server/db.js';
import type { LayoutServerLoad } from './$types';

// Rich, non-trivial load data: a Date, a Map, nested objects — all devalue-serialized
// into the page and available to islands via the page shim.
export const load: LayoutServerLoad = () => {
	return {
		user: currentUser(),
		navCounts: statusCounts()
	};
}
