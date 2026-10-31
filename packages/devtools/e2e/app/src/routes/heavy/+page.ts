// Never prerender: this route must render on the server for every request so the profiler
// has real, repeatable SSR work to sample. csr stays false (inherited from the root layout).
export const prerender = false;
