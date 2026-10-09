// THE STAMPED-COOKIE LAB for the profiler: the page reads nothing of the visitor and renders the
// same document every time (a slow catalogue read), so a cache could answer it, but a hook sets a
// cookie on its answer (hooks.server.ts, stamp_cookie), and no shared cache keeps such an answer.
// The profiler's same-document finding must name the cookie first; /dt-cookie-free (no cookie) not.
import type { PageServerLoad } from './$types';

const catalogue = async () => {
	await new Promise((r) => setTimeout(r, 25));
	return ['anchor', 'buoy', 'compass', 'davit'];
};

export const load: PageServerLoad = async () => ({ items: await catalogue() });
