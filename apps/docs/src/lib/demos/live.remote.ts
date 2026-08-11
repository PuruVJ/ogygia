import { query } from '$app/server';
import { region } from 'ogygia';
// A `with { region: 'raw' }` component held with no wake schedule ships no client JS: the server
// renders it each tick and the runtime morphs it in place on the client.
import LiveTick from './LiveTick.svelte' with { region: 'raw' };

// Live partial demo: each tick yields an AWAITED partial, so the server-rendered HTML rides Kit's
// SSE channel and the client swaps/morphs it with no per-tick fetch. `yield` awaits it for us.
export const liveTick = query.live(async function* () {
	let n = 1;
	while (true) {
		yield region(LiveTick, { n, at: new Date().toISOString() }); // yield awaits it → HTML baked
		n += 1;
		await new Promise((r) => setTimeout(r, 1000));
	}
});
