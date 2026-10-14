---
"ogygia": minor
---

SvelteKit 3 only: ogygia supports what SvelteKit 3 and Svelte 5 support (SvelteKit 2 is dropped). Kit's config is read from `sveltekit({...})`; `#lib` and other package.json `"imports"` entries are followed; `$app/stores` in islands needs `ogygia({ legacy: { appStores: true } })`.
