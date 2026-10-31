// Never prerender: this route must render on the server every request so the profiler sees its
// I/O waits (a fake DB query, sequential upstream fetches, a file read). csr stays false.
export const prerender = false;
