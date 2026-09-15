/**
 * The plugin inside a REAL Vite: a production build (the barrel leaves the module graph, the leaves
 * stay) and a dev server (`transformRequest` shows leaf imports; editing a barrel re-transforms the
 * importer through `addWatchFile`), with the Svelte plugin next to it and a fake dependency with an
 * `exports` map opted in through `packages`. Plus the `ogygia({ barrels })` wiring: the pass is
 * first in the array and skips region-marked imports.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { build, createServer, type Plugin, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fixture, type Fixture } from './_fixture.js';
import { debarrel } from '../../src/compiler/debarrel/plugin.js';
import { ogygia } from '../../src/vite/index.js';

let f: Fixture;
afterEach(() => f?.dispose());

const app = () => ({
	'package.json': JSON.stringify({ name: 'app', type: 'module' }),
	'index.html': `<script type="module" src="/src/main.ts"></script>`,
	'src/main.ts': `import { Button, util } from '$lib';\nimport { pkgLeaf } from '@scope/ui';\nimport App from './App.svelte';\nconsole.log(Button, util, pkgLeaf, App);`,
	'src/App.svelte': `<script lang="ts">\n\timport { Card } from '$lib';\n</script>\n<Card />`,
	'lib/Button.svelte': '<button>b</button>',
	'lib/Card.svelte': '<div>c</div>',
	'lib/Unused.svelte': '<div>never imported: must not be in the graph</div>',
	'lib/util.ts': 'export function util() { return "util-marker"; }',
	'lib/index.ts': `export { default as Button } from './Button.svelte';\nexport { default as Card } from './Card.svelte';\nexport { default as Unused } from './Unused.svelte';\nexport { util } from './util';`,
	'node_modules/@scope/ui/package.json': JSON.stringify({ name: '@scope/ui', type: 'module', exports: { '.': './index.js' } }),
	'node_modules/@scope/ui/leaf.js': 'export const pkgLeaf = "leaf"; globalThis.__pkg_leaf_loaded = true;',
	'node_modules/@scope/ui/heavy.js': 'export const heavy = "heavy"; globalThis.__heavy_loaded = true;',
	'node_modules/@scope/ui/index.js': `export { pkgLeaf } from './leaf.js';\nexport { heavy } from './heavy.js';`
});

const config = (f: Fixture, extra: Parameters<typeof debarrel>[0] = {}) => ({
	root: f.root,
	logLevel: 'silent' as const,
	configFile: false as const,
	resolve: { alias: { $lib: f.id('lib') } },
	optimizeDeps: { noDiscovery: true, include: [] },
	plugins: [
		debarrel({ packages: ['@scope/ui'], ...(extra === true ? {} : extra) }),
		svelte({ configFile: false, compilerOptions: { css: 'injected' } })
	]
});

const module_ids = (out: Rollup.RollupOutput) =>
	out.output.flatMap((c) => (c.type === 'chunk' ? Object.keys(c.modules) : []));

const build_ids = async (cfg: ReturnType<typeof config>) => {
	const out = (await build({ ...cfg, build: { write: false, minify: false } })) as Rollup.RollupOutput;
	return { out, ids: module_ids(out).map((m) => m.split('?')[0]) };
};

describe('vite build', () => {
	it('the barrel and its unused leaves are not in the bundle; the used leaves are; the package barrel is bypassed too', async () => {
		f = fixture(app());
		const { out, ids } = await build_ids(config(f));
		expect(ids).toContain(f.id('lib/Button.svelte'));
		expect(ids).toContain(f.id('lib/Card.svelte'));
		expect(ids).toContain(f.id('lib/util.ts'));
		expect(ids).toContain(f.id('src/App.svelte'));
		expect(ids, 'the barrel module itself is gone').not.toContain(f.id('lib/index.ts'));
		expect(ids, 'a leaf nobody imported is gone').not.toContain(f.id('lib/Unused.svelte'));
		expect(ids).toContain(f.id('node_modules/@scope/ui/leaf.js'));
		expect(ids, 'the package barrel is gone').not.toContain(f.id('node_modules/@scope/ui/index.js'));
		expect(ids, 'the package sibling nobody asked for is gone').not.toContain(f.id('node_modules/@scope/ui/heavy.js'));
		const code = out.output.map((c) => (c.type === 'chunk' ? c.code : '')).join('\n');
		expect(code).not.toContain('__heavy_loaded');
		expect(code).toContain('__pkg_leaf_loaded');
	});

	it('without the plugin the barrel and every leaf are in the graph (the baseline the pass beats)', async () => {
		f = fixture(app());
		const cfg = config(f);
		cfg.plugins = cfg.plugins.slice(1);
		const { ids } = await build_ids(cfg);
		expect(ids).toContain(f.id('lib/index.ts'));
		expect(ids, 'a Svelte component is not sideEffects-free to the bundler, so the unused one survives').toContain(f.id('lib/Unused.svelte'));
	});

	it('a `keep` matcher leaves that barrel alone even though it is pure', async () => {
		f = fixture(app());
		const { ids } = await build_ids(config(f, { keep: ['$lib'] }));
		expect(ids).toContain(f.id('lib/index.ts'));
		expect(ids, 'the package barrel is still bypassed').not.toContain(f.id('node_modules/@scope/ui/index.js'));
	});

	it('a package NOT opted in is left alone (dev pre-bundling safety)', async () => {
		f = fixture(app());
		const cfg = config(f);
		cfg.plugins[0] = debarrel(true);
		const { ids } = await build_ids(cfg);
		expect(ids).not.toContain(f.id('lib/index.ts'));
		expect(ids).toContain(f.id('node_modules/@scope/ui/index.js'));
	});

	it('the build report names the totals, the time, and the top barrels with their importer counts; `debug` narrates each rewrite', async () => {
		f = fixture(app());
		const lines: string[] = [];
		const logger = { info: (m: string) => lines.push(m), warn() {}, warnOnce() {}, error() {}, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false };
		const cfg = { ...config(f, { debug: true }), customLogger: logger as never, logLevel: 'info' as const };
		await build_ids(cfg);
		const report = lines.find((l) => /^\[ogygia\] barrels: \d/.test(l))!;
		expect(report).toMatch(/^\[ogygia\] barrels: 2 of \d+ files rewritten — 3 barrel imports → leaves \(4 names\), 2 barrels bypassed, \d+\.\d\d s first to last transform\n/);
		expect(report).toContain('names  lib/index.ts  ← 2 importers');
		expect(report).toContain('names  node_modules/@scope/ui/index.js  ← 1 importer');
		expect(lines.filter((l) => l.startsWith('[ogygia] barrels: src/main.ts:'))).toHaveLength(2);
		expect(lines).toContainEqual(expect.stringContaining('[ogygia] barrels: src/App.svelte: Card ← lib/index.ts → lib/Card.svelte'));
		// `report: false` silences the block
		lines.length = 0;
		await build_ids({ ...config(f, { report: false }), customLogger: logger as never, logLevel: 'info' as const });
		expect(lines.some((l) => /^\[ogygia\] barrels: \d/.test(l))).toBe(false);
	});
});

describe('vite dev', { timeout: 30_000 }, () => {
	it('transformRequest returns leaf imports for a TS module and a Svelte component', async () => {
		f = fixture(app());
		const server = await createServer({ ...config(f), server: { middlewareMode: true, hmr: false } });
		try {
			const main = (await server.transformRequest('/src/main.ts'))!;
			expect(main.code).toContain(`/lib/Button.svelte`);
			expect(main.code).not.toMatch(/from\s+['"]\$lib['"]/);
			expect(main.code).not.toMatch(/from\s+['"]@scope\/ui['"]/);
			const comp = (await server.transformRequest('/src/App.svelte'))!;
			expect(comp.code).toContain('/lib/Card.svelte');
			expect(comp.code).not.toContain('/lib/index.ts');
		} finally {
			await server.close();
		}
	});

	it('editing a barrel re-points the importer on the next transform (watch + invalidate)', async () => {
		f = fixture(app());
		const server = await createServer({ ...config(f), server: { middlewareMode: true, hmr: false } });
		try {
			const before = (await server.transformRequest('/src/main.ts'))!;
			expect(before.code).toContain('/lib/util.ts');
			// the barrel changes: `util` now comes from a different leaf
			f.write('lib/util2.ts', 'export function util() { return "util2"; }');
			f.write('lib/index.ts', f.read('lib/index.ts').replace(`export { util } from './util';`, `export { util } from './util2';`));
			// what Vite's watcher does on a change to a watched file
			server.watcher.emit('change', f.id('lib/index.ts'));
			server.moduleGraph.invalidateAll();
			await new Promise((r) => setTimeout(r, 200));
			const after = (await server.transformRequest('/src/main.ts'))!;
			expect(after.code).toContain('/lib/util2.ts');
			expect(after.code).not.toContain('/lib/util.ts');
		} finally {
			await server.close();
		}
	});
});

describe('ogygia({ barrels }) wiring', () => {
	const names = (plugins: Plugin[]) => plugins.map((p) => p.name);

	it('off by default; `true` or an object puts the debarrel plugin FIRST in the array', () => {
		expect(names(ogygia({}))).not.toContain('ogygia:debarrel');
		expect(names(ogygia({ barrels: true }))[0]).toBe('ogygia:debarrel');
		expect(names(ogygia({ barrels: { keep: ['x'] } }))[0]).toBe('ogygia:debarrel');
	});

	it('the wired plugin skips imports carrying the app\'s region-mark keys (custom importKeys too), rewrites the rest', async () => {
		f = fixture({
			'lib/Button.svelte': '<button/>',
			'lib/util.ts': 'export function util() { return "util-marker"; }',
			'lib/index.ts': `export { default as Button } from './Button.svelte';\nexport { util } from './util';`,
			'src/app.ts': `import { Button } from '$lib' with { hydrate: 'visible' };\nimport { util } from '$lib';`
		});
		const plugin = ogygia({ barrels: true, importKeys: { wake: 'hydrate' } })[0];
		const transform = plugin.transform as (this: unknown, code: string, id: string) => Promise<{ code: string } | null>;
		const ctx = {
			resolve: async (spec: string, importer: string) => {
				const id = await f.host().resolve(spec, importer);
				return id ? { id } : null;
			},
			addWatchFile() {}
		};
		(plugin.configResolved as (c: unknown) => void)({ root: f.root, command: 'serve', logger: { info() {} } });
		const out = await transform.call(ctx, f.read('src/app.ts'), f.id('src/app.ts'));
		expect(out!.code).toBe(`import { Button } from '$lib' with { hydrate: 'visible' };\nimport { util } from '${f.id('lib/util.ts')}';`);
	});

	it('a specifier Vite cannot resolve (it THROWS from `this.resolve`) leaves that import alone and the rest still moves', async () => {
		f = fixture({
			'lib/util.ts': 'export const util = 1;',
			'lib/index.ts': `export { util } from './util';`,
			'src/app.ts': `import { Action } from 'svelte/action';\nimport { util } from '$lib';\nimport { deep } from '@vendor/pkg/src/types';`
		});
		const plugin = debarrel(true);
		const transform = plugin.transform as (this: unknown, code: string, id: string) => Promise<{ code: string } | null>;
		const ctx = {
			resolve: async (spec: string, importer: string) => {
				if (!spec.startsWith('$lib') && !spec.startsWith('.')) throw new Error(`Errored while resolving "${spec}" in \`this.resolve\`.`);
				const id = await f.host().resolve(spec, importer);
				return id ? { id } : null;
			},
			addWatchFile() {}
		};
		(plugin.configResolved as (c: unknown) => void)({ root: f.root, command: 'build', logger: { info() {} } });
		const out = await transform.call(ctx, f.read('src/app.ts'), f.id('src/app.ts'));
		expect(out!.code).toBe(`import { Action } from 'svelte/action';\nimport { util } from '${f.id('lib/util.ts')}';\nimport { deep } from '@vendor/pkg/src/types';`);
	});
});
