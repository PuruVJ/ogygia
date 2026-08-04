import { defineConfig } from 'tsdown';

// Build the library's JS/TS modules to dist/ with .d.ts, PRESERVING the source module
// structure (`unbundle`). Structure must stay parallel because:
//   - the vite plugin resolves sibling modules via `new URL('../runtime/index.js', ...)` /
//     `../shims/*.js` (fileURLToPath) — those targets must exist at the same relative paths;
//   - the `.svelte` wrappers import `./server/*.js` relatively.
//
// The Svelte-pipeline files are NOT compiled here (the CONSUMER's vite-plugin-svelte compiles
// them): the three `.svelte` components and the runes module `shims/remote-client.svelte.js`
// ship as raw source (copied by the `copy:svelte` build step) and are kept external here.
export default defineConfig({
	entry: ['src/**/*.ts', '!src/**/*.svelte.ts', '!src/**/*.d.ts'],
	format: 'esm',
	platform: 'neutral', // library runs in node (vite plugin/hooks) AND the browser (runtime)
	unbundle: true,
	dts: true,
	clean: true,
	treeshake: false, // keep every module intact; nothing here is dead code
	external: [
		// peers / deps — never inline
		'svelte',
		'svelte/compiler',
		'svelte/server',
		'devalue',
		'magic-string',
		'estree-walker',
		// consumer-resolved specifiers
		/^node:/,
		/^virtual:/,
		/^\$app\//,
		/\.svelte$/, // the 3 wrapper components (shipped as source)
		'ogygia/runtime',
		'ogygia/internal'
	]
});
