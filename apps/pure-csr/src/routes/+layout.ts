// Explicitly csr=true (also the SvelteKit default) — and NO route below sets csr=false, so this is
// a PURE csr=true app. ogygia emits no runtime chunk. SSR stays on so the widget renders on the
// server and Kit hydrates it in the browser.
export const csr = true;
export const prerender = false;
