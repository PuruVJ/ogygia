import type { PageServerLoad } from './$types';
import { dash } from '$lib/federation.server.js';

// A Kit route returning REGION values from its load — proof of the wire law. Kit serializes load
// data with devalue; `src/hooks.ts` (`...ogygia.transport`) teaches it the region codec, so these
// regions cross the load→page boundary and revive. Two dash widgets:
//  - `static` (default): baked into this anonymous SSR render — freezable (reads no per-visitor state).
//  - `deferred`: a hole the browser fetches from the shell's own signed endpoint (per-visitor).
export const load: PageServerLoad = async () => {
	return {
		kpis: await dash.widget('kpis', { org: 'acme' }),
		live: await dash.widget('kpis', { org: 'live-inc' }, { render: 'deferred' })
	};
};
