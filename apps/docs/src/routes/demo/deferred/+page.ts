// Prerendered shell; the `render: 'deferred'` hole still fetches its HTML per request (no-store by
// default), so the embedding frame's "Fetch again" replays a real server round-trip. csr stays false.
export const prerender = true;
