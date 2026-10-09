/**
 * `import { A, B } from 'barrel'; const ARegion = import.meta.og.asRegion(A)` keeps working with the
 * pass on: debarrel runs first and turns the named barrel import into a default import of the leaf
 * file, which is exactly the form `asRegion` already accepts. The island then points at the leaf
 * (one chunk for A), not at the barrel. The pipeline here is the real one — the debarrel rewrite,
 * then the compiler's `.ts` region transform on its output.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fixture, type Fixture } from './_fixture.js';
import { transformTsRegions, asRegionLocals } from '../../src/compiler/region/transform.js';
import { ogygia } from '../../src/vite/index.js';

let f: Fixture;
afterEach(() => f?.dispose());

const ctx = (root: string) => ({
	root,
	libDir: root + '/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (_host: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
	wrapperPathFor: (_host: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
	devUrlFor: (p: string) => '/@id/' + p,
	visibleMargin: '0px',
	presets: {}
});

describe('debarrel + import.meta.og.asRegion', () => {
	it('the CORE alone (no ogygia policy) would rewrite an asRegion import to the leaf — which is exactly why ogygia tells it not to (next test)', async () => {
		f = fixture({
			'lib/A.svelte': '<h1>A</h1>',
			'lib/B.svelte': '<p>B</p>',
			'lib/index.ts': `export { default as A } from './A.svelte';\nexport { default as B } from './B.svelte';`,
			'src/registry.ts': `import { A, B } from '$lib';\nconst ARegion = import.meta.og.asRegion(A, { wake: 'visible' });\nexport const registry = [ARegion, B];`
		});
		const rewritten = (await f.rewrite('src/registry.ts'))!;
		expect(rewritten).toBe(
			`import A from '${f.id('lib/A.svelte')}';\nimport B from '${f.id('lib/B.svelte')}';\nconst ARegion = import.meta.og.asRegion(A, { wake: 'visible' });\nexport const registry = [ARegion, B];`
		);
		const r = transformTsRegions(rewritten, f.id('src/registry.ts'), ctx(f.root));
		expect(r).not.toBeNull();
		expect(r!.islands).toHaveLength(1);
		const isl = r!.islands[0] as Record<string, unknown>;
		expect(isl.held).toBe(true);
		expect(String(isl.bindingSsrSource)).toContain('__hydrate: "visible"');
		// the island's entry imports the LEAF file, not the barrel
		expect(String(isl.source)).toMatch(/import __OgygiaComp_[0-9a-f]+ from ["'][^"']*\/lib\/A\.svelte["']/);
		expect(String(isl.source)).not.toContain('index.ts');
		expect(r!.code).not.toContain('import.meta.og.asRegion');
		// B stays a plain default import of its leaf
		expect(r!.code).toContain(`import B from '${f.id('lib/B.svelte')}';`);
	});

	it('the same file WITHOUT the pass still compiles through the barrel (nothing changed for apps that leave barrels on)', async () => {
		f = fixture({
			'lib/A.svelte': '<h1>A</h1>',
			'lib/index.ts': `export { default as A } from './A.svelte';`,
			'src/registry.ts': `import { A } from '$lib';\nconst ARegion = import.meta.og.asRegion(A, { wake: 'load' });\nexport const registry = [ARegion];`
		});
		const r = transformTsRegions(f.read('src/registry.ts'), f.id('src/registry.ts'), ctx(f.root));
		expect(r!.islands).toHaveLength(1);
		expect(String((r!.islands[0] as Record<string, unknown>).source)).toMatch(/import \{ A as __OgygiaComp_[0-9a-f]+ \} from /);
	});

	it('INSIDE ogygia the import feeding asRegion is left alone: the prescan keys the island on the raw import, the transform must see the same one', async () => {
		// REGRESSION (customer build, 2026-09-15): with `barrels: true` the transform saw
		// `import A from '…/A.svelte'` where the prescan (raw source) saw `import { A } from '$lib'` —
		// two island ids, and the server manifest imported a virtual entry nobody registered:
		// "Rolldown failed to resolve import virtual:ogygia/island/<id>.js from virtual:ogygia/server-manifest".
		f = fixture({
			'lib/A.svelte': '<h1>A</h1>',
			'lib/B.svelte': '<p>B</p>',
			'lib/util.ts': 'export const util = 1;',
			'lib/index.ts': `export { default as A } from './A.svelte';\nexport { default as B } from './B.svelte';\nexport { util } from './util';`,
			'src/registry.ts': `import { A, B } from '$lib';\nimport { util } from '$lib';\nconst ARegion = import.meta.og.asRegion(A, { wake: 'visible' });\nexport const registry = [ARegion, B, util];`
		});
		const skip = (decl: { specs: { local: string }[] }) => decl.specs.some((s) => asRegionLocals(f.read('src/registry.ts')).has(s.local));
		expect(await f.rewrite('src/registry.ts', undefined, { skip })).toBe(
			`import { A, B } from '$lib';\nimport { util } from '${f.id('lib/util.ts')}';\nconst ARegion = import.meta.og.asRegion(A, { wake: 'visible' });\nexport const registry = [ARegion, B, util];`
		);
		// and the island id is the one the prescan computes from the raw file
		const raw = transformTsRegions(f.read('src/registry.ts'), f.id('src/registry.ts'), ctx(f.root));
		const rewritten = (await f.rewrite('src/registry.ts', undefined, { skip }))!;
		const after = transformTsRegions(rewritten, f.id('src/registry.ts'), ctx(f.root));
		expect((after!.islands[0] as Record<string, unknown>).id).toBe((raw!.islands[0] as Record<string, unknown>).id);
	});

	it('the wired plugin (ogygia({ barrels })) applies that rule end to end', async () => {
		f = fixture({
			'lib/A.svelte': '<h1>A</h1>',
			'lib/util.ts': 'export const util = 1;',
			'lib/index.ts': `export { default as A } from './A.svelte';\nexport { util } from './util';`,
			'src/registry.ts': `import { A } from '$lib';\nimport { util } from '$lib';\nexport const R = import.meta.og.asRegion(A, { wake: 'load' });\nexport const u = util;`
		});
		const plugin = ogygia({ barrels: true })[0];
		const transform = plugin.transform as (this: unknown, code: string, id: string) => Promise<{ code: string } | null>;
		const ctx_ = {
			resolve: async (spec: string, importer: string) => {
				const id = await f.host().resolve(spec, importer);
				return id ? { id } : null;
			},
			addWatchFile() {}
		};
		(plugin.configResolved as (c: unknown) => void)({ root: f.root, command: 'build', logger: { info() {} } });
		const out = await transform.call(ctx_, f.read('src/registry.ts'), f.id('src/registry.ts'));
		expect(out!.code).toBe(`import { A } from '$lib';\nimport { util } from '${f.id('lib/util.ts')}';\nexport const R = import.meta.og.asRegion(A, { wake: 'load' });\nexport const u = util;`);
	});

	it('a region-MARKED barrel import is left to the compiler (skip policy), so the mark still errors or works exactly as before', async () => {
		f = fixture({
			'lib/A.svelte': '<h1>A</h1>',
			'lib/index.ts': `export { default as A } from './A.svelte';`,
			'src/host.ts': `import { A } from '$lib' with { wake: 'visible' };\nexport const x = A;`
		});
		const skip = (decl: { attribute_keys: string[] }) => decl.attribute_keys.includes('wake');
		expect(await f.rewrite('src/host.ts', undefined, { skip })).toBeNull();
	});
});
