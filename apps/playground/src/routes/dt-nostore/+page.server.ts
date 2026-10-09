// THE NO-STORE LAB for the profiler: the page answers Cache-Control: no-store (a habit copied from
// pages that hold private data), so the browser keeps it out of its back/forward cache — every Back
// renders it again. The profiler must name it; a page without the header never.
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });
	return { at: 'no-store lab' };
};
