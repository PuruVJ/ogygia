// REGRESSION: the eager island-closure walk (prescan) follows the app's ALIASES. A module reached
// from an island only through `$lib_x/…` (Kit's `kit.alias` / Vite's `resolve.alias`) used to stop
// the walk, so its `$app/*` shim decision fell back to bundler order: a helper shared with a
// csr=true page resolved Kit's REAL page store (empty under csr=false) whenever that page was
// reached first. Seen on a customer's dev server: `page.data.user` empty inside every island on
// public pages after an account page had loaded the shared boot helper.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Compiler, Program, CompileCtx, normalize_import_keys } from '../dist/compiler/index.js';

let root = '';

const files: Record<string, string> = {
	'src/routes/+layout.ts': 'export const csr = false;\n',
	'src/routes/+page.svelte': `<script>\n\timport Reader from '$lib/Reader.svelte' with { wake: 'load' };\n</script>\n<Reader />\n`,
	'src/lib/Reader.svelte': `<script>\n\timport { page_name } from '$boot/read-page';\n\timport { relative_helper } from './relative-helper';\n</script>\n<p>{page_name()} {relative_helper()}</p>\n`,
	'src/lib/relative-helper.ts': `export const relative_helper = () => 'r';\n`,
	'src/lib/boot/read-page.ts': `import { page } from '$app/state';\nexport const page_name = () => String(page.data.name ?? '');\n`,
	'src/lib/boot/deeper.ts': `export const deeper = 1;\n`
};

function make_compiler(resolve_alias: { find: string | RegExp; replacement: string }[]) {
	const program = new Program({ forms: true, router: true });
	const profiler = {
		prof: {
			transformMs: 0,
			transformN: 0,
			transformHit: 0,
			prescanMs: 0,
			bakeMs: 0,
			bakeN: 0,
			resolveMs: 0,
			loadMs: 0
		},
		P: false,
		outHash: new Map<string, number>()
	};
	const compiler = new Compiler(program, profiler);
	compiler.configure(
		new CompileCtx({
			root,
			base: '/',
			libDir: path.join(root, 'src/lib'),
			is_dev: false,
			id_salt: '',
			visibleMargin: '0px',
			presets: {},
			import_keys: normalize_import_keys(undefined),
			resolve_alias,
			markdown_config: null,
			pkg_root: '/nowhere/ogygia',
			app_shims: {
				'$app/state': '/nowhere/ogygia/shims/app-state.svelte.js',
				'$app/stores': '/nowhere/ogygia/shims/app-stores.js',
				'$app/navigation': '/nowhere/ogygia/shims/app-navigation.js'
			}
		})
	);
	return { compiler, program };
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-closure-alias-'));
	for (const [rel, src] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, src);
	}
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('island closure walk follows app aliases', () => {
	test('a helper reached through a `kit.alias` import is island code after prescan', () => {
		const { compiler, program } = make_compiler([
			{ find: '$boot', replacement: path.join(root, 'src/lib/boot') }
		]);
		compiler.prescan();
		expect(
			program.island_graph.has(path.join(root, 'src/lib/Reader.svelte')),
			'the island component'
		).toBe(true);
		expect(
			program.island_graph.has(path.join(root, 'src/lib/relative-helper.ts')),
			'a relative import'
		).toBe(true);
		expect(
			program.island_graph.has(path.join(root, 'src/lib/boot/read-page.ts')),
			'the alias import'
		).toBe(true);
	});

	test('the marked script helper leaves the client transform importing the SHIM, not Kit’s `$app/state`', async () => {
		const { compiler } = make_compiler([
			{ find: '$boot', replacement: path.join(root, 'src/lib/boot') }
		]);
		compiler.prescan();
		const abs = path.join(root, 'src/lib/boot/read-page.ts');
		const out = await compiler.transform_module(fs.readFileSync(abs, 'utf8'), abs, {
			ssr: false,
			emitFile: () => {}
		});
		expect(out, 'the client leg rewrote the module').not.toBeNull();
		// Vite's alias plugin resolves `$app/state` before this plugin's resolveId runs, so the
		// specifier itself must already point at the shim when the module leaves the transform.
		expect(out!.code).not.toContain("'$app/state'");
		expect(out!.code).toMatch(/from\s*["'][^"']*shims\/app-state\.svelte\.js["']/);
		// the SSR leg keeps Kit's real module
		const ssr = await compiler.transform_module(fs.readFileSync(abs, 'utf8'), abs, {
			ssr: true,
			emitFile: () => {}
		});
		expect(ssr === null || ssr.code.includes("'$app/state'")).toBe(true);
	});

	test('a RegExp alias (Kit’s shape for `key/*`) is followed too', () => {
		const { compiler, program } = make_compiler([
			{ find: /^\$boot\/(.+)$/, replacement: path.join(root, 'src/lib/boot') + '/$1' }
		]);
		compiler.prescan();
		expect(program.island_graph.has(path.join(root, 'src/lib/boot/read-page.ts'))).toBe(true);
	});
});
