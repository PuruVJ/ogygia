import { query, command } from '$app/server';
import { region } from 'ogygia';
import CountBadge from './CountBadge.svelte' with { region: 'raw' };
import { bumpBadgeCount } from './badge-count';

export const getBadge = query(async () => await region(CountBadge, {}));

// SINGLE-FLIGHT: one response settles the write AND carries the re-rendered region (baked HTML at the
// same call address), so the mounted region morphs in place — no follow-up fetch.
export const bumpBadge = command(async () => {
	bumpBadgeCount();
	return await region(CountBadge, {});
});
