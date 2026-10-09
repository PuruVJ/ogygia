/**
 * The barrel index: every way a name can travel through re-exports, and every way the walk must
 * stop (impure module, cycle, kept, opaque). Fixtures are real files in a temp dir; the resolver
 * is the harness's (relative + `$lib` + a fake node_modules with `exports`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './_fixture.js';

let f: Fixture;
afterEach(() => f?.dispose());

const leaf = (f: Fixture, rel: string, name: string) => ({ id: f.id(rel), name });

describe('export map — the basic shapes', () => {
	it('named, renamed, default-as-name, star: each name points at its leaf', async () => {
		f = fixture({
			'lib/a.ts': 'export const a = 1; export const b = 2;',
			'lib/Button.svelte': '<button>x</button>',
			'lib/c.ts': 'export const c = 3; export default 4;',
			'lib/index.ts': `export { a, b as bee } from './a';\nexport { default as Button } from './Button.svelte';\nexport * from './c';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.pure).toBe(true);
		expect(m.opaque).toBe(false);
		expect(m.entries.get('a')).toEqual(leaf(f, 'lib/a.ts', 'a'));
		expect(m.entries.get('bee')).toEqual(leaf(f, 'lib/a.ts', 'b'));
		expect(m.entries.get('Button')).toEqual(leaf(f, 'lib/Button.svelte', 'default'));
		expect(m.entries.get('c')).toEqual(leaf(f, 'lib/c.ts', 'c'));
		expect(m.entries.has('default'), 'a star never carries default').toBe(false);
		expect([...m.deps]).toEqual(expect.arrayContaining([f.id('lib/index.ts'), f.id('lib/a.ts'), f.id('lib/c.ts')]));
	});

	it('import-then-export bindings resolve like direct re-exports', async () => {
		f = fixture({
			'lib/a.ts': 'export const a = 1;',
			'lib/d.ts': 'export default 1;',
			'lib/n.ts': 'export const one = 1;',
			'lib/index.ts': `import { a as x } from './a';\nimport d from './d';\nimport * as n from './n';\nexport { x as y, d, n };\nexport default d;`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('y')).toEqual(leaf(f, 'lib/a.ts', 'a'));
		expect(m.entries.get('d')).toEqual(leaf(f, 'lib/d.ts', 'default'));
		expect(m.entries.get('n')).toEqual({ id: f.id('lib/n.ts'), namespace: true });
		expect(m.entries.get('default')).toEqual(leaf(f, 'lib/d.ts', 'default'));
	});

	it('export * as ns → a namespace leaf', async () => {
		f = fixture({ 'lib/n.ts': 'export const one = 1;', 'lib/index.ts': `export * as ns from './n';` });
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('ns')).toEqual({ id: f.id('lib/n.ts'), namespace: true });
	});

	it('a .js barrel with .js-suffixed relative specifiers (nodenext style) resolves the same', async () => {
		f = fixture({ 'lib/a.ts': 'export const a = 1;', 'lib/index.js': `export { a } from './a.js';` });
		const i = f.index({
			resolve: async (spec, importer) => {
				const base = spec.endsWith('.js') ? spec.slice(0, -3) : spec;
				return f.host().resolve(base, importer);
			}
		});
		const m = (await i.map(f.id('lib/index.js'), '$lib'))!;
		expect(m.entries.get('a')).toEqual(leaf(f, 'lib/a.ts', 'a'));
	});
});

describe('nesting — barrels of barrels', () => {
	it('a rename chain three barrels deep lands on the original leaf and name', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const original = 1;',
			'lib/b1.ts': `export { original as one } from './leaf';`,
			'lib/b2.ts': `export { one as two } from './b1';`,
			'lib/index.ts': `export { two as three } from './b2';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('three')).toEqual(leaf(f, 'lib/leaf.ts', 'original'));
	});

	it('a star into a nested pure barrel is transparent; into an impure module it stops there', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const deep = 1;',
			'lib/pure.ts': `export * from './leaf';`,
			'lib/impure.ts': `export const own = 1; export { deep as viaImpure } from './leaf'; registerSomething();`,
			'lib/index.ts': `export * from './pure';\nexport * from './impure';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('deep')).toEqual(leaf(f, 'lib/leaf.ts', 'deep'));
		expect(m.entries.get('own'), 'an impure module IS the leaf for its own names').toEqual(leaf(f, 'lib/impure.ts', 'own'));
		expect(m.entries.get('viaImpure'), 'but its re-exports still resolve through it').toEqual(leaf(f, 'lib/leaf.ts', 'deep'));
	});

	it('explicit re-exports win over stars; two stars with different leaves for one name are ambiguous', async () => {
		f = fixture({
			'lib/x.ts': 'export const same = "x"; export const only_x = 1;',
			'lib/y.ts': 'export const same = "y"; export const only_y = 2;',
			'lib/z.ts': 'export const same = "z";',
			'lib/index.ts': `export { same } from './z';\nexport * from './x';\nexport * from './y';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('same'), 'explicit wins').toEqual(leaf(f, 'lib/z.ts', 'same'));
		expect(m.entries.get('only_x')).toEqual(leaf(f, 'lib/x.ts', 'only_x'));
		f.write('lib/index.ts', `export * from './x';\nexport * from './y';`);
		const m2 = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m2.entries.get('same')).toBe('ambiguous');
	});

	it('a diamond — the same leaf reached by two paths — is NOT ambiguous', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const d = 1;',
			'lib/p.ts': `export * from './leaf';`,
			'lib/q.ts': `export { d } from './leaf';`,
			'lib/index.ts': `export * from './p';\nexport * from './q';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('d')).toEqual(leaf(f, 'lib/leaf.ts', 'd'));
	});

	it('cycles terminate: a ↔ b, and a barrel that stars itself', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/a.ts': `export * from './b';\nexport { l } from './leaf';`,
			'lib/b.ts': `export * from './a';\nexport const bb = 2;`,
			'lib/self.ts': `export * from './self';\nexport * from './leaf';`
		});
		const i = f.index();
		const a = (await i.map(f.id('lib/a.ts'), './a'))!;
		expect(a.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
		expect(a.entries.get('bb')).toEqual(leaf(f, 'lib/b.ts', 'bb'));
		const self = (await i.map(f.id('lib/self.ts'), './self'))!;
		expect(self.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
	});

	it('a nested barrel re-exporting a name its own star does not carry stays honest: unknown names are absent', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/mid.ts': `export { l } from './leaf';`,
			'lib/index.ts': `export { l, nope } from './mid';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
		// `nope` does not exist in mid: the best we know is "mid is where it would live"
		expect(m.entries.get('nope')).toEqual(leaf(f, 'lib/mid.ts', 'nope'));
	});
});

describe('where the walk stops', () => {
	it('an impure module is not a barrel unless forced; forced keeps own names as own', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/index.ts': `export { l } from './leaf';\nexport const store = createStore();`
		});
		expect(await f.index().map(f.id('lib/index.ts'), '$lib')).toBeNull();
		const forced = (await f.index({ forced: () => true }).map(f.id('lib/index.ts'), '$lib'))!;
		expect(forced.pure).toBe(false);
		expect(forced.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
		expect(forced.entries.get('store')).toBe('own');
	});

	it('kept beats everything; a non-candidate is never mapped', async () => {
		f = fixture({ 'lib/leaf.ts': 'export const l = 1;', 'lib/index.ts': `export { l } from './leaf';` });
		expect(await f.index({ kept: () => true }).map(f.id('lib/index.ts'), '$lib')).toBeNull();
		expect(await f.index({ candidate: () => false }).map(f.id('lib/index.ts'), '$lib')).toBeNull();
	});

	it('a kept module in the MIDDLE of a chain is the leaf (the walk does not look through it)', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/mid.ts': `export { l } from './leaf';`,
			'lib/index.ts': `export * from './mid';`
		});
		const m = (await f.index({ kept: (id) => id.endsWith('/mid.ts') }).map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.opaque).toBe(true);
		expect(m.entries.has('l')).toBe(false);
	});

	it('a query id (?raw, ?url) is never a barrel; a re-export FROM a query id stays on the barrel', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/index.ts': `export { l } from './leaf';\nexport { default as raw } from './leaf.ts?raw';`
		});
		const i = f.index({
			resolve: async (spec, importer) => (spec.endsWith('?raw') ? f.id('lib/leaf.ts') + '?raw' : f.host().resolve(spec, importer))
		});
		expect(await i.map(f.id('lib/index.ts') + '?raw', '$lib')).toBeNull();
		const m = (await i.map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
		expect(m.entries.has('raw')).toBe(false);
		expect(m.opaque).toBe(true);
	});

	it('a star into something unparsable (json, missing, a syntax error, virtual) makes the map OPAQUE, the rest still maps', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/data.json': '{"k":1}',
			'lib/broken.ts': 'export const = ;',
			'lib/index.ts': `export { l } from './leaf';\nexport * from './data.json';\nexport * from './missing';\nexport * from './broken';\nexport * from 'virtual:thing';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.opaque).toBe(true);
		expect(m.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
		expect(m.entries.size).toBe(1);
	});

	it('a CommonJS module behind a star is opaque (module.exports is not an export list)', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/cjs.js': 'module.exports = { c: 1 };',
			'lib/index.ts': `export { l } from './leaf';\nexport * from './cjs';`
		});
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.opaque, 'a CJS module parses but declares no exports and runs code — an impure leaf with nothing to see').toBe(false);
		expect(m.entries.has('c')).toBe(false);
	});

	it('follow_packages: false makes a star into node_modules opaque; true walks it', async () => {
		f = fixture({
			'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': './index.js', './leaf': './leaf.js' } }),
			'node_modules/pkg/leaf.js': 'export const p = 1;',
			'node_modules/pkg/index.js': `export * from './leaf.js';`,
			'lib/index.ts': `export * from 'pkg';`
		});
		const closed = (await f.index({ follow_packages: false }).map(f.id('lib/index.ts'), '$lib'))!;
		expect(closed.opaque).toBe(true);
		expect(closed.entries.has('p')).toBe(false);
		const open = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		expect(open.entries.get('p')).toEqual({ id: f.id('node_modules/pkg/leaf.js'), name: 'p' });
	});

	it('a package barrel is a candidate only when opted in (packages), then its exports map is walked', async () => {
		f = fixture({
			'node_modules/@scope/ui/package.json': JSON.stringify({ name: '@scope/ui', exports: { '.': './index.js', './components': './components.js' } }),
			'node_modules/@scope/ui/Button.svelte': '<button/>',
			'node_modules/@scope/ui/components.js': `export { default as Button } from './Button.svelte';`,
			'node_modules/@scope/ui/index.js': `export * from './components.js';`
		});
		const spec = '@scope/ui/components';
		const id = f.id('node_modules/@scope/ui/components.js');
		expect(await f.index().map(id, spec)).toBeNull();
		const m = (await f.index({ packages: ['@scope/ui'] }).map(id, spec))!;
		expect(m.entries.get('Button')).toEqual({ id: f.id('node_modules/@scope/ui/Button.svelte'), name: 'default' });
	});
});

describe('concurrency — what a real build does', () => {
	const slow = (f: Fixture, ms: number) => async (spec: string, importer: string) => {
		await new Promise((r) => setTimeout(r, ms));
		return f.host().resolve(spec, importer);
	};

	it('two hundred importers asking for one barrel at once all get the SAME finished map (one build in flight)', async () => {
		f = fixture({
			'lib/a.ts': 'export const a = 1;',
			'lib/b.ts': 'export const b = 2;',
			'lib/mid.ts': `export * from './b';`,
			'lib/index.ts': `export { a } from './a';\nexport * from './mid';`
		});
		let resolves = 0;
		const i = f.index({
			resolve: async (spec, importer) => {
				resolves++;
				return slow(f, 5)(spec, importer);
			}
		});
		const maps = await Promise.all(Array.from({ length: 200 }, () => i.map(f.id('lib/index.ts'), '$lib')));
		expect(maps.every((m) => m === maps[0])).toBe(true);
		expect(maps[0]!.entries.get('a')).toEqual(leaf(f, 'lib/a.ts', 'a'));
		expect(maps[0]!.entries.get('b')).toEqual(leaf(f, 'lib/b.ts', 'b'));
		expect(maps[0]!.provisional).toBe(false);
		expect(resolves, 'the barrel and its nested barrel were each walked once').toBe(3);
	});

	it('two walks that need each other (a → b while b → a is in flight) neither deadlock nor cache a hole', async () => {
		f = fixture({
			'lib/la.ts': 'export const la = 1;',
			'lib/lb.ts': 'export const lb = 2;',
			'lib/a.ts': `export * from './b';\nexport { la } from './la';`,
			'lib/b.ts': `export * from './a';\nexport { lb } from './lb';`
		});
		const i = f.index({ resolve: slow(f, 3) });
		// start both at once: each one's star reaches the other while it is in flight
		const [a1, b1] = await Promise.all([i.map(f.id('lib/a.ts'), './a'), i.map(f.id('lib/b.ts'), './b')]);
		expect(a1!.entries.get('la')).toEqual(leaf(f, 'lib/la.ts', 'la'));
		expect(b1!.entries.get('lb')).toEqual(leaf(f, 'lib/lb.ts', 'lb'));
		// whichever side met the other mid-flight is provisional and gets rebuilt on the next ask
		const a2 = (await i.map(f.id('lib/a.ts'), './a'))!;
		const b2 = (await i.map(f.id('lib/b.ts'), './b'))!;
		expect(a2.entries.get('lb')).toEqual(leaf(f, 'lib/lb.ts', 'lb'));
		expect(b2.entries.get('la')).toEqual(leaf(f, 'lib/la.ts', 'la'));
		expect(a2.provisional).toBe(false);
		expect(b2.provisional).toBe(false);
		expect(await i.map(f.id('lib/a.ts'), './a'), 'cached now').toBe(a2);
	});

	it('many importers, many barrels, all at once: every name lands home', async () => {
		const files: Record<string, string> = {};
		for (let b = 0; b < 20; b++) {
			for (let l = 0; l < 5; l++) files[`lib/b${b}/l${l}.ts`] = `export const n${b}_${l} = ${l};`;
			files[`lib/b${b}/index.ts`] = Array.from({ length: 5 }, (_, l) => `export * from './l${l}';`).join('\n');
		}
		files['lib/index.ts'] = Array.from({ length: 20 }, (_, b) => `export * from './b${b}';`).join('\n');
		f = fixture(files);
		const i = f.index({ resolve: slow(f, 1) });
		const asks = [];
		for (let k = 0; k < 60; k++) asks.push(i.map(f.id(k % 3 === 0 ? 'lib/index.ts' : `lib/b${k % 20}/index.ts`), 'x'));
		const maps = await Promise.all(asks);
		for (const m of maps) expect(m).not.toBeNull();
		const top = (await i.map(f.id('lib/index.ts'), 'x'))!;
		expect(top.entries.size).toBe(100);
		expect(top.entries.get('n19_4')).toEqual(leaf(f, 'lib/b19/l4.ts', 'n19_4'));
	});
});

describe('cache + invalidation', () => {
	it('a map is cached; invalidating a DEPENDENCY drops every map that walked through it', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/mid.ts': `export { l } from './leaf';`,
			'lib/index.ts': `export * from './mid';`
		});
		const i = f.index();
		const first = (await i.map(f.id('lib/index.ts'), '$lib'))!;
		expect(first.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
		expect(await i.map(f.id('lib/index.ts'), '$lib')).toBe(first);
		// the middle barrel changes: `l` now comes from elsewhere
		f.write('lib/other.ts', 'export const l = 2;');
		f.write('lib/mid.ts', `export { l } from './other';`);
		i.invalidate(f.id('lib/mid.ts'));
		const second = (await i.map(f.id('lib/index.ts'), '$lib'))!;
		expect(second).not.toBe(first);
		expect(second.entries.get('l')).toEqual(leaf(f, 'lib/other.ts', 'l'));
	});

	it('invalidating a leaf that turned impure re-classifies the chain on the next map', async () => {
		f = fixture({
			'lib/leaf.ts': 'export const l = 1;',
			'lib/mid.ts': `export * from './leaf';`,
			'lib/index.ts': `export * from './mid';`
		});
		const i = f.index();
		expect((await i.map(f.id('lib/index.ts'), '$lib'))!.entries.get('l')).toEqual(leaf(f, 'lib/leaf.ts', 'l'));
		f.write('lib/mid.ts', `export * from './leaf';\nsideEffect();`);
		i.invalidate(f.id('lib/mid.ts'));
		const m = (await i.map(f.id('lib/index.ts'), '$lib'))!;
		expect(m.entries.get('l'), 'mid is impure now: l still resolves THROUGH it to the leaf').toEqual(leaf(f, 'lib/leaf.ts', 'l'));
	});

	it('at scale: a 2 000-name barrel over 200 leaves maps in well under a second and points every name home', async () => {
		const files: Record<string, string> = {};
		const lines: string[] = [];
		for (let i = 0; i < 200; i++) {
			files[`lib/leaves/l${i}.ts`] = Array.from({ length: 10 }, (_, j) => `export const n${i}_${j} = ${j};`).join('\n');
			lines.push(`export * from './leaves/l${i}';`);
		}
		files['lib/index.ts'] = lines.join('\n');
		f = fixture(files);
		const t0 = performance.now();
		const m = (await f.index().map(f.id('lib/index.ts'), '$lib'))!;
		const ms = performance.now() - t0;
		expect(m.entries.size).toBe(2000);
		expect(m.entries.get('n199_9')).toEqual(leaf(f, 'lib/leaves/l199.ts', 'n199_9'));
		expect(ms).toBeLessThan(1000);
	});
});
