import { error } from '@sveltejs/kit';

// A csr=false page whose load always 404s: Kit renders the layout's `+error.svelte` instead, from
// the LAYOUT branch (csr=true there) — this page's `csr = false` never applies to its own 404.
export const csr = false;

export function load() {
	error(404, 'no such product');
}
