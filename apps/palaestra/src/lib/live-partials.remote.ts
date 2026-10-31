import { query } from '$app/server';
import { region } from 'ogygia';
// Held regions: the SSR leg carries the real component + signer + server render; the client leg is
// metadata-only. `wake: 'load'` bakes an interactive schedule (region() respects it); `region: 'raw'`
// bakes none → HTML only, no client JS.
import LiveStat from './LiveStat.svelte' with { wake: 'load' };
import StatBadge from './StatBadge.svelte' with { region: 'raw' };

// INTERACTIVE live partial: each tick yields an AWAITED partial. `yield` in an async generator
// awaits the value, so the component is rendered to HTML on the server and the ticket travels with
// its markup — the client swaps it in with no fetch, then keep-alives (prop push) across ticks.
export const liveStat = query.live(async function* () {
	let n = 0;
	while (true) {
		yield region(LiveStat, { value: n }); // baked wake:'load'; async-generator `yield` awaits it → HTML baked
		n += 1;
		await new Promise((r) => setTimeout(r, 1000));
	}
});

// STATIC live partial: no client JS. The runtime morphs the freshly rendered HTML in place.
export const liveBadge = query.live(async function* () {
	let n = 0;
	while (true) {
		yield await region(StatBadge, { value: n, at: new Date().toISOString() });
		n += 1;
		await new Promise((r) => setTimeout(r, 1000));
	}
});
