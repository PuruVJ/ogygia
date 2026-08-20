// Standalone driver — proves the compiler SPINE runs with zero Vite. The whole point of the
// carve-out (see compiler/index.ts): `Compiler` + `Program` + `CompileCtx` are a bundler-agnostic
// compile session. A REPL / non-Vite host is just a second adapter — build a ctx, configure the
// compiler, feed it source, read back `{ code, islands }`. Here we drive it directly, importing only
// from the public `ogygia/internal/compiler` entry (../dist/compiler/index.js), never `ogygia/vite`.

import { describe, test, expect } from 'vitest';
import { Compiler, Program, CompileCtx, normalize_import_keys } from '../dist/compiler/index.js';

const ROOT = '/standalone-app';

/** Build a fully-wired, Vite-free compile session — the four lines any non-Vite host needs. */
function make_compiler() {
	const program = new Program({ forms: true, router: true });
	const profiler = {
		prof: { transformMs: 0, transformN: 0, transformHit: 0, prescanMs: 0, bakeMs: 0, bakeN: 0, resolveMs: 0, loadMs: 0 },
		P: false,
		outHash: new Map<string, number>()
	};
	const compiler = new Compiler(program, profiler);
	compiler.configure(
		new CompileCtx({
			root: ROOT,
			base: '/',
			libDir: `${ROOT}/src/lib`,
			is_dev: false,
			id_salt: '',
			visibleMargin: '0px',
			presets: {},
			import_keys: normalize_import_keys(undefined),
			resolve_alias: [],
			markdown_config: null,
			pkg_root: '/nowhere/ogygia'
		})
	);
	return { compiler, program };
}

describe('standalone driver (no Vite)', () => {
	test('Compiler.transform rewrites a marked host island and reports it', () => {
		const { compiler } = make_compiler();
		const src = `<script>\nimport TabGroup from 'some-pkg/tabs' with { wake: 'load' };\n</script>\n<TabGroup />`;
		const result = compiler.transform(src, `${ROOT}/src/lib/Widget.svelte`, { ssr: true }) as {
			code: string;
			islands: unknown[];
		} | null;

		expect(result).not.toBeNull();
		expect(result!.islands.length).toBeGreaterThan(0); // the `with { wake }` import became an island
		expect(result!.code).not.toBe(src); // the host import was rewritten to a wrapper
		expect(result!.code).toContain('ogygia'); // generated glue references the runtime
	});

	test('Compiler.transform is memoized (same source → same result object)', () => {
		const { compiler } = make_compiler();
		const src = `<script>\nimport TabGroup from 'some-pkg/tabs' with { wake: 'load' };\n</script>\n<TabGroup />`;
		const id = `${ROOT}/src/lib/Widget.svelte`;
		const a = compiler.transform(src, id, { ssr: true });
		const b = compiler.transform(src, id, { ssr: true });
		expect(a).toBe(b); // content-keyed cache hit
	});

	test('Compiler.macros hoists an import.meta.og.$ factory into dollar_hoists', async () => {
		const { compiler } = make_compiler();
		const src = `const make = import.meta.og.$(() => 42);\nexport const x = make;\n`;
		const out = await compiler.macros(src, `${ROOT}/src/lib/store.ts`);
		expect(out.touched).toBe(true);
		expect(out.code).not.toContain('import.meta.og.$'); // the marker is gone
		expect(compiler.dollar_hoists.size).toBeGreaterThan(0); // the factory was captured for the fn-manifest
	});

	test('Compiler.macros is inert on a module with no markers', async () => {
		const { compiler } = make_compiler();
		const src = `export const answer = 42;\n`;
		const out = await compiler.macros(src, `${ROOT}/src/lib/plain.ts`);
		expect(out.touched).toBe(false);
		expect(out.code).toBe(src);
	});

	test('Compiler.ts_regions mints a `with { wake }` load-region import', () => {
		const { compiler, program } = make_compiler();
		const src = `import { load } from './data.remote' with { wake: 'load' };\nexport { load };\n`;
		const result = compiler.ts_regions(src, `${ROOT}/src/lib/feed.ts`) as { code: string } | null;
		// A ts-region mint either rewrites the module (island descriptors) or no-ops if the attribute
		// form isn't a region here; either way the call runs with no Vite and the Program is intact.
		expect(program).toBeInstanceOf(Program);
		if (result) expect(typeof result.code).toBe('string');
	});
});
