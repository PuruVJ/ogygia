import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// A PURE csr=true app: no route anywhere sets `csr = false`, so `hasAnyCsrFalseRoute` is false and
// ogygia emits NO runtime chunk. The point of the fixture is exactly that build shape — see
// e2e/pure-csr.ts.
export default defineConfig({
	plugins: [ogygia(), sveltekit()]
});
