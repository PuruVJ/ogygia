import type { PageServerLoad } from './$types';
import { stitch } from '$lib/stitch.server.js';

// SSR stitch: the await happens in the SHELL's server render. The page ships with
// dash's HTML already inside — one paint, no client fetch for the pixels.
export const load: PageServerLoad = async () => {
	return { kpis: await stitch('kpis', { org: 'acme' }) };
};
