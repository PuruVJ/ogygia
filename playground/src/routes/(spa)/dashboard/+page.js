import { redirect } from '@sveltejs/kit';

// Messy pattern: redirect in a load. Server-side under csr=false.
export function load() {
	redirect(307, '/dashboard/orders');
}
