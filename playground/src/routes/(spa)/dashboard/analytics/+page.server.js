import { analytics } from '$lib/server/db.js';

export function load() {
	return { stats: analytics() };
}
