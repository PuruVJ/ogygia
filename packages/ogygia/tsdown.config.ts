import { defineConfig } from 'tsdown';

// Build the library's JS/TS modules to dist/ with .d.ts, PRESERVING the source module
// structure (`unbundle`). Structure must stay parallel because:
//   - the vite plugin resolves sibling modules via `new URL('../runtime/index.js', ...)` /
//     `../shims/*.js` (fileURLToPath) — those targets must exist at the same relative paths;
//   - the `.svelte` wrappers import `./server/*.js` relatively.
//
// The `.svelte` COMPONENTS (with templates) are NOT compiled here — they ship as raw source
// (copied by `copy:svelte`) and the CONSUMER's vite-plugin-svelte compiles them. The `.svelte.ts`
// runes MODULES (page-store, app-state) are template-free TypeScript: tsdown strips their types
// and leaves the `$state` runes intact, so the consumer's svelte pipeline compiles the emitted
// `.svelte.js`. They are emitted as entries here (the `$app/state` vite alias imports the built
// `.svelte.js` by absolute path, so it must exist in dist even though nothing else imports it).
export default defineConfig({
	entry: ['src/**/*.ts', '!src/**/*.d.ts'],
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
		/^@sveltejs\/kit(\/|$)/,
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
