import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Messy pattern: redirect in a load. Server-side under csr=false.
export const load: PageLoad = () => {
	redirect(307, '/dashboard/orders');
};
