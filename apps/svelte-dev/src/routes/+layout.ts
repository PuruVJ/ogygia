// ogygia is csr=false-only; the whole app renders on the server with live island holes.
// Fully PRERENDERED: every docs page is static HTML (entries come from the pharos outline in
// `docs/[...slug]/+page.server.ts`); the node server only exists for the region endpoint + /docs/search.
export const csr = false;
export const prerender = true;
