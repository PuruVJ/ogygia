import { cpSync, existsSync, globSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocess, type PreprocessorGroup } from 'svelte/compiler';
import { emitDts } from 'svelte2tsx';
import { defineConfig } from 'tsdown';

const pkg_root = fileURLToPath(new URL('.', import.meta.url));

// Ship `.svelte` COMPONENTS and standalone `.css` into dist/ at their parallel paths, plus a
// `.svelte.d.ts` beside each component — the full svelte-package treatment, without compiling
// the template to JS:
//   - `buildStart` runs each `.svelte` through `preprocess()` (stripping `lang="ts"` + the leftover
//     `lang` attribute) and emits it as a raw Svelte template the CONSUMER's vite-plugin-svelte
//     compiles. `.css` is copied verbatim. A glob replaces the old hardcoded copy-svelte.mjs list.
//   - `writeBundle` runs svelte2tsx's `emitDts` (the same engine svelte-package uses) to generate
//     component types, then copies only the `*.svelte.d.ts` into dist — tsdown stays the source of
//     truth for `.ts`/`.svelte.ts` declarations. NOTE: svelte2tsx needs classic TypeScript; it hard-
//     refuses the TS7 Go port, so this package pins `typescript@6`.
// Pass the preprocessor group (e.g. `vitePreprocess({ script: true })`); no svelte.config.js reuse.
// Assets are emitted in `buildStart` / copied in `writeBundle` so `clean: true` does not wipe them.
const copy_svelte_source = (preprocessor: PreprocessorGroup | PreprocessorGroup[]) => ({
	name: 'ogygia:copy-svelte-source',
	async buildStart() {
		for (const abs of globSync('src/**/*.{svelte,css}')) {
			const fileName = abs.replace(/^src[\\/]/, '');
			let source: string | Buffer = readFileSync(abs, 'utf8');
			if (abs.endsWith('.svelte')) {
				({ code: source } = await preprocess(source as string, preprocessor, { filename: abs }));
				// preprocess strips the TS but leaves `lang="ts"` on the tag; drop it so the shipped
				// component is plain JS the consumer compiles with no TS preprocessor required.
				source = source.replace(/(<script\b[^>]*?)\s+lang=(["'])ts\2/g, '$1');
			}
			// @ts-expect-error — rolldown plugin context `this.emitFile`
			this.emitFile({ type: 'asset', fileName, source });
		}
	},
	async writeBundle() {
		// Emit component d.ts into a scratch dir (svelte2tsx also emits `.ts` d.ts we don't want),
		// then graft only the component `*.svelte.d.ts` onto dist.
		const tmp = join(pkg_root, '.svelte-dts');
		rmSync(tmp, { recursive: true, force: true });
		await emitDts({
			libRoot: join(pkg_root, 'src'),
			declarationDir: tmp,
			svelteShimsPath: fileURLToPath(import.meta.resolve('svelte2tsx/svelte-shims-v4.d.ts'))
		});
		for (const abs of globSync('src/**/*.svelte')) {
			const rel = `${abs.replace(/^src[\\/]/, '')}.d.ts`;
			const from = join(tmp, rel);
			if (existsSync(from)) cpSync(from, join(pkg_root, 'dist', rel));
		}
		rmSync(tmp, { recursive: true, force: true });
	}
});

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
// tsdown accepts an ARRAY of configs — [0] is the library (unbundled, externalized), [1] is the
// `ogygia` CLI (`npx ogygia init`), built as a SINGLE self-contained bundle so the published package
// declares no extra runtime dependency for it. cli.ts is excluded from the library build (entry
// negation) so this bundled copy is the only dist/cli.* — the library's externals would otherwise
// emit a broken cli with `@sveltejs/sv-utils` left external.
export default defineConfig([
	{
		entry: ['src/**/*.ts', '!src/**/*.d.ts', '!src/cli.ts'],
		format: 'esm',
		platform: 'neutral', // library runs in node (vite plugin/hooks) AND the browser (runtime)
		unbundle: true,
		dts: true,
		clean: true,
		treeshake: false, // keep every module intact; nothing here is dead code
		// `script: true` strips `lang="ts"` types (off by default in vite-plugin-svelte v7).
		plugins: [copy_svelte_source(vitePreprocess({ script: true }))],
		deps: {
			// never inline — peers / deps / consumer-resolved specifiers
			neverBundle: [
				'svelte',
				'svelte/compiler',
				'svelte/server',
				/^@sveltejs\/kit(\/|$)/,
				'devalue',
				'magic-string',
				'estree-walker',
				// content deps / optional peers
				'yaml',
				'mdsvex',
				'shiki',
				'vite',
				// lazy optional peer of js_to_ts() — bundling would freeze a store path (it once
				// resolved to typescript/lib/version.js and shipped a ts with no ScriptTarget)
				'typescript',
				// consumer-resolved specifiers
				/^node:/,
				/^virtual:/,
				/^\$app\//,
				/\.svelte$/, // the 3 wrapper components (shipped as source)
				'ogygia/runtime',
				'ogygia/internal',
				'ogygia/internal/server'
			]
		}
	},
	{
		entry: ['src/cli.ts'],
		format: 'esm',
		platform: 'node',
		dts: false,
		clean: false, // library build [0] already cleaned dist/
		treeshake: true,
		// Bundle EVERYTHING (`@sveltejs/sv-utils` + its deps) into one file; keep only node builtins external.
		deps: {
			alwaysBundle: [/.*/],
			neverBundle: [/^node:/]
		}
	}
]);
