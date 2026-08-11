// Prerendered: the whole shell is baked to a static file at build. The `render: 'deferred'` hole
// inside still fetches its own HTML per request — that is partial prerendering. csr stays false
// (inherited from the root layout), so this page ships no Kit client bootstrap.
export const prerender = true;
