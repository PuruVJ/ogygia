import { analytics } from '$lib/server/db.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return { stats: analytics() };
};
