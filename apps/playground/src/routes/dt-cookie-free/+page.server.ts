// THE CONTROL for /dt-cookie: the same slow, same-every-time page with no cookie set on its answer.
// The profiler's same-document finding says "cache it" with nothing to clear first.
import type { PageServerLoad } from './$types';

const catalogue = async () => {
	await new Promise((r) => setTimeout(r, 25));
	return ['anchor', 'buoy', 'compass', 'davit'];
};

export const load: PageServerLoad = async () => ({ items: await catalogue() });
