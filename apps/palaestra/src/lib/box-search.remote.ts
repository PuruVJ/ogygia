import { query } from '$app/server';
import * as v from 'valibot';
import { region } from 'ogygia';
// A held region for the boundary experiment: `region: 'raw'` → HTML only, its own CSS asset. The
// page that renders the result never imports Hero, so the styles travel with the region.
import Hero from './blocks/Hero.svelte' with { region: 'raw' };

// Returns an AWAITED held region (baked HTML rides the ticket → client swaps, no second fetch).
export const boxSearch = query(v.string(), async (q) => {
	await new Promise((r) => setTimeout(r, 800)); // simulate a slow lookup — makes the FETCH phase observable
	return await region(Hero, { title: `Result: ${q}`, tagline: 'server-picked, page never imported it' });
});
