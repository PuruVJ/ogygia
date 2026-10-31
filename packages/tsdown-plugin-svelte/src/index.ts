/**
 * A tsdown plugin that ships a library's Svelte components the way svelte-package does, inside a
 * normal tsdown build:
 *
 *   - every `.svelte` under `src` is preprocessed (its script's TS transpiled), its markup's TS cut
 *     (`strip_markup_ts`) and `lang="ts"` dropped, then emitted into the output dir at the same
 *     path as a raw, plain-JS component. It is NOT compiled: the consumer's own Svelte compiles it,
 *     so the library never bakes in a Svelte version. Templates may use TypeScript freely.
 *   - standalone `.css` files are copied as they are.
 *   - `.svelte.d.ts` types are generated beside each component with svelte2tsx (the engine
 *     svelte-package uses). tsdown stays in charge of the `.ts` declarations.
 *   - relative `./x.ts` imports in both (a source written with real extensions) become `./x.js`,
 *     the built modules they sit beside.
 *
 * Assets are emitted in `buildStart` and types copied in `writeBundle`, so tsdown's `clean` never
 * wipes them.
 */
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocess, type PreprocessorGroup } from 'svelte/compiler';
import { strip_markup_ts } from './strip-ts.ts';

export { strip_markup_ts };

export interface SvelteOptions {
	/** the package root the other paths are relative to (default: the working directory) */
	root?: string;
	/** the source dir holding the components (default: `src`) */
	src?: string;
	/** the output dir, tsdown's `outDir` (default: `dist`) */
	out?: string;
	/** preprocessors for the script and style (default: vite-plugin-svelte's `vitePreprocess({ script: true })`) */
	preprocess?: PreprocessorGroup | PreprocessorGroup[];
	/** generate `.svelte.d.ts` beside each component (default: true; needs `svelte2tsx` and `typescript`) */
	dts?: boolean;
	/** the tsconfig the component types are emitted with, relative to `root` (default: `tsconfig.json`) */
	tsconfig?: string;
}

/** The scratch tsconfig the component types are emitted with (found by name from `src` upward). */
const DTS_TSCONFIG = '.svelte-dts.tsconfig.json';

interface EmitContext {
	emitFile(file: { type: 'asset'; fileName: string; source: string | Uint8Array }): string;
}

/** the path of `abs` inside `dir`, with forward slashes */
const rel_to = (dir: string, abs: string) => relative(dir, abs).split('\\').join('/');

const RELATIVE_TS_SPECIFIER =
	/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+?)\.ts\2/g;

/** A shipped component sits beside the BUILT modules: its relative `./x.ts` imports (static, dynamic,
 *  or a JSDoc `import('./x.ts')` type) name `./x.js`, the way tsdown rewrites the `.ts` sources. */
export function js_specifiers(source: string): string {
	return source.replace(RELATIVE_TS_SPECIFIER, '$1$2$3.js$2');
}

async function default_preprocess(): Promise<PreprocessorGroup> {
	try {
		const { vitePreprocess } = await import('@sveltejs/vite-plugin-svelte');
		return vitePreprocess({ script: true });
	} catch {
		throw new Error(
			'@ogygia/tsdown-plugin-svelte: pass `preprocess`, or install @sveltejs/vite-plugin-svelte for the default'
		);
	}
}

export function svelte(options: SvelteOptions = {}) {
	const root = resolve(options.root ?? process.cwd());
	const src = resolve(root, options.src ?? 'src');
	const out = resolve(root, options.out ?? 'dist');
	return {
		name: '@ogygia/tsdown-plugin-svelte',
		async buildStart(this: EmitContext) {
			const pre = options.preprocess ?? (await default_preprocess());
			for (const file of globSync('**/*.{svelte,css}', { cwd: src })) {
				const abs = join(src, file);
				const fileName = rel_to(src, abs);
				let source = readFileSync(abs, 'utf8');
				if (abs.endsWith('.svelte')) {
					({ code: source } = await preprocess(source, pre, { filename: abs }));
					source = js_specifiers(strip_markup_ts(source, abs));
				}
				this.emitFile({ type: 'asset', fileName, source });
			}
		},
		async writeBundle() {
			if (options.dts === false) return;
			const { emitDts } = await import('svelte2tsx');
			// svelte2tsx also emits `.ts` declarations tsdown already owns: emit into a scratch dir,
			// then graft only the component `*.svelte.d.ts` onto the output
			const tmp = join(root, '.svelte-dts');
			rmSync(tmp, { recursive: true, force: true });
			// the library's own tsconfig, with `isolatedDeclarations` off: svelte2tsx's generated
			// component code never carries the annotations it demands, so a library that turns it on
			// for its `.ts` would otherwise get no component types at all
			const base = resolve(root, options.tsconfig ?? 'tsconfig.json');
			const scratch = join(root, DTS_TSCONFIG);
			if (existsSync(base))
				writeFileSync(
					scratch,
					JSON.stringify({
						extends: './' + rel_to(root, base),
						compilerOptions: { isolatedDeclarations: false }
					})
				);
			try {
				await emitDts({
					libRoot: src,
					declarationDir: tmp,
					svelteShimsPath: fileURLToPath(import.meta.resolve('svelte2tsx/svelte-shims-v4.d.ts')),
					...(existsSync(scratch) ? { tsconfig: DTS_TSCONFIG } : {})
				});
				for (const file of globSync('**/*.svelte', { cwd: src })) {
					const rel = rel_to(src, join(src, file)) + '.d.ts';
					const from = join(tmp, rel);
					if (!existsSync(from)) continue;
					const to = join(out, rel);
					mkdirSync(dirname(to), { recursive: true });
					writeFileSync(to, js_specifiers(readFileSync(from, 'utf8')));
				}
			} finally {
				rmSync(tmp, { recursive: true, force: true });
				rmSync(scratch, { force: true });
			}
		}
	};
}

export default svelte;
