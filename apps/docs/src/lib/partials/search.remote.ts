/**
 * A search remote that returns a *component*, not JSON. The server holds the data, picks which
 * component should render each result, fills its props, and hands back a signed partial. The
 * client renders whatever it receives — it never imports PackageCard or EmptyResult itself.
 *
 * This is the RSC-shaped path: server decides the UI, client just paints it.
 */
import PackageCard from '$lib/partials/PackageCard.svelte' with { wake: 'load' };
import EmptyResult from '$lib/partials/EmptyResult.svelte' with { region: 'raw' };
import { query } from '$app/server';
import { region } from 'ogygia';
import * as v from 'valibot';

const DB: Record<string, { name: string; tagline: string; lang: string; stars: number }> = {
	svelte: { name: 'Svelte', tagline: 'Cybernetically enhanced web apps.', lang: 'TS', stars: 79000 },
	kit: { name: 'SvelteKit', tagline: 'The fastest way to build Svelte apps.', lang: 'TS', stars: 19000 },
	vite: { name: 'Vite', tagline: 'Next generation frontend tooling.', lang: 'TS', stars: 68000 },
	ogygia: { name: 'ogygia', tagline: 'Astro-style SSR islands for SvelteKit.', lang: 'TS', stars: 1 }
};

export const search = query(v.string(), async (raw) => {
	const key = raw.trim().toLowerCase();
	const hit = DB[key];
	// interactive card for a hit (PackageCard bakes wake:'load'); static "no match" otherwise.
	return hit ? region(PackageCard, hit) : region(EmptyResult, { query: raw });
});
