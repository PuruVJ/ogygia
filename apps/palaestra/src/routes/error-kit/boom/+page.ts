// A csr=false page whose load throws: Kit answers 500 with the layout's `+error.svelte`, rendered
// from the LAYOUT branch (csr=true) — the same shape as the 404 sibling, the other status.
export const csr = false;

export function load() {
	throw new Error('upstream exploded');
}
