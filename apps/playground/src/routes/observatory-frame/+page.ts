// The isolated preview lives here: a csr=false page with its OWN ogygia runtime + svelte instance.
// The Observatory embeds it as an <iframe> and drives it over postMessage (see Harness).
export const csr = false;
export const prerender = false;
export const ssr = true;
