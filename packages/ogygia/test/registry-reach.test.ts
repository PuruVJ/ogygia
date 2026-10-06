// The csr=false client leg's registry reach walk (driver `#reaches_registry`): does a module imported
// by a csr=false route host reach a region registry through static script imports?
//
// REGRESSION (a large field app, 2026-10-06): the walk memoized a negative answer only at the TOP of
// a walk, so every shared helper below was read, parsed and walked again from every path to it —
// effectively exponential; the production build ran 17+ minutes without finishing. Guards:
//   (1) a wide fan-out over a deep shared chain reads each module at most once per build;
//   (2) a registry behind a plain helper still resolves to the client-leg variant;
//   (3) a cycle whose far side reaches a registry resolves positive from either entry point, and a
//       cycle that reaches nothing resolves negative — no early, wrong memo either way.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Compiler, Program, CompileCtx, normalize_import_keys } from '../dist/compiler/index.js';

const FAN = 40;
const DEPTH = 30;
const QUERY = '?og-registry-client';

let root = '';

function write(rel: string, src: string) {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, src);
}

/** A resolver shaped like the plugin context's: relative specifiers with extension probing. */
async function resolve(source: string, importer: string) {
	if (!source.startsWith('.')) return null;
	const base = path.resolve(path.dirname(importer.split('?')[0]), source);
	for (const ext of ['', '.ts', '.svelte']) {
		if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return { id: base + ext };
	}
	return null;
}

function make_compiler() {
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
	const ctx = new CompileCtx({
		root,
		base: '/',
		libDir: path.join(root, 'src/lib'),
		is_dev: false,
		is_build: true,
		id_salt: '',
		visibleMargin: '0px',
		presets: {},
		import_keys: normalize_import_keys(undefined),
		resolve_alias: [],
		markdown_config: null,
		pkg_root: '/nowhere/ogygia',
		app_shims: {}
	} as never);
	const reads = new Map<string, number>();
	const read_file = ctx.read_file.bind(ctx);
	ctx.read_file = (abs: string) => {
		reads.set(abs, (reads.get(abs) ?? 0) + 1);
		return read_file(abs);
	};
	compiler.configure(ctx);
	return { compiler, reads };
}

const page = (dir: string) => path.join(root, 'src/routes', dir, '+page.svelte');
const lib = (rel: string) => path.join(root, 'src/lib', rel);

async function client_resolve(
	compiler: InstanceType<typeof Compiler>,
	source: string,
	importer: string
) {
	return compiler.resolve_id(source, importer, { ssr: false, resolve });
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-registry-reach-'));
	write('src/routes/+layout.ts', 'export const csr = false;\n');
	write('src/lib/Block.svelte', '<p>block</p>\n');
	write(
		'src/lib/registry.ts',
		`import Block from './Block.svelte' with { wake: 'visible' };\nexport const blocks = { block: Block };\n`
	);

	// (1) wide fan-out over a deep shared chain, reaching no registry
	let barrel = '';
	for (let i = 0; i < FAN; i++) {
		write(`src/lib/fan/m${i}.ts`, `import { c } from '../chain/c0';\nexport const m${i} = c;\n`);
		barrel += `export * from './fan/m${i}';\n`;
	}
	write('src/lib/barrel.ts', barrel);
	for (let d = 0; d < DEPTH; d++) {
		const next =
			d + 1 < DEPTH
				? `import { c as n } from './c${d + 1}';\nexport const c = n;\n`
				: 'export const c = 1;\n';
		write(`src/lib/chain/c${d}.ts`, next);
	}
	write(
		'src/routes/fan/+page.svelte',
		`<script>\n\timport * as b from '$lib/barrel';\n</script>\n`
	);

	// (2) a registry behind a plain helper
	write(
		'src/lib/factory.ts',
		`import { blocks } from './registry';\nexport const pick = (k: string) => blocks[k];\n`
	);
	write(
		'src/routes/helper/+page.svelte',
		`<script>\n\timport { pick } from '$lib/factory';\n</script>\n`
	);

	// (3) cycles: a → b → a with b → registry; x → y → x reaching nothing
	write('src/lib/cyc/a.ts', `import { b } from './b';\nexport const a = () => b;\n`);
	write(
		'src/lib/cyc/b.ts',
		`import { a } from './a';\nimport { blocks } from '../registry';\nexport const b = () => [a, blocks];\n`
	);
	write('src/lib/cyc/x.ts', `import { y } from './y';\nexport const x = () => y;\n`);
	write(
		'src/lib/cyc/y.ts',
		`import { x } from './x';\nimport { c } from '../chain/c0';\nexport const y = () => [x, c];\n`
	);
	write('src/routes/cyc/+page.svelte', '<p>cyc</p>\n');
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('registry reach walk', () => {
	test('a wide fan-out over a deep shared chain reads each module once, and stays shared', async () => {
		const { compiler, reads } = make_compiler();
		// the build's prescan reads the source tree once on its own; count only the walk's reads
		compiler.prescan();
		reads.clear();
		expect(await client_resolve(compiler, './../../lib/barrel', page('fan'))).toBeNull();
		for (let i = 0; i < FAN; i++)
			expect(reads.get(lib(`fan/m${i}.ts`)) ?? 0).toBeLessThanOrEqual(1);
		for (let d = 0; d < DEPTH; d++)
			expect(reads.get(lib(`chain/c${d}.ts`)) ?? 0).toBeLessThanOrEqual(1);
		// a second host asking again answers from the memo: no new reads
		const before = [...reads.values()].reduce((a, b) => a + b, 0);
		expect(await client_resolve(compiler, './../../lib/fan/m3', page('fan'))).toBeNull();
		expect([...reads.values()].reduce((a, b) => a + b, 0)).toBe(before);
	});

	test('a registry behind a plain helper resolves to the client-leg variant', async () => {
		const { compiler } = make_compiler();
		expect(await client_resolve(compiler, './../../lib/factory', page('helper'))).toBe(
			lib('factory.ts') + QUERY
		);
	});

	test('cycles: the far side reaching a registry wins from either entry; a dead cycle stays negative', async () => {
		const { compiler } = make_compiler();
		expect(await client_resolve(compiler, './../../lib/cyc/a', page('cyc'))).toBe(
			lib('cyc/a.ts') + QUERY
		);
		expect(await client_resolve(compiler, './../../lib/cyc/b', page('cyc'))).toBe(
			lib('cyc/b.ts') + QUERY
		);
		const fresh = make_compiler().compiler;
		// entered from b first this time: a must not be memoized negative while b is still open
		expect(await client_resolve(fresh, './../../lib/cyc/b', page('cyc'))).toBe(
			lib('cyc/b.ts') + QUERY
		);
		expect(await client_resolve(fresh, './../../lib/cyc/a', page('cyc'))).toBe(
			lib('cyc/a.ts') + QUERY
		);
		expect(await client_resolve(compiler, './../../lib/cyc/x', page('cyc'))).toBeNull();
		expect(await client_resolve(compiler, './../../lib/cyc/y', page('cyc'))).toBeNull();
	});
});
