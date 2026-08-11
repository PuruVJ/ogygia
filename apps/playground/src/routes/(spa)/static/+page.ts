// Prerendered to static HTML at build time. The page shell + regular islands are baked into
// the file; the server island stays a runtime hole (it calls the server at hydration).
export const prerender = true;
