// Transform suite — portable binding rewrite (0.4.0). Asserts host import rewrites, wrapper/entry
// virtual modules, path+strategy dedupe, props/fallback/children rules, defer+hydrate, lakes,
// presets, and csr-independent emit metadata. Runs against built `../dist/vite/transform.js`.

import { describe, test, expect } from 'vitest';
import path from 'node:path';
import {
	transformHost,
	normalize_import_keys,
	islandPublicUrl,
	regionIdentity,
	regionId,
	strategyKey,
	wrapperVirtualId,
	CLIENT_BINDING_STUB
} from '../dist/vite/transform.js';

const ROOT = '/app';
const HOST = '/app/src/routes/+page.svelte';

function idFor(
	compRel: string,
	mark: { strategy: string; options?: Record<string, unknown> },
	salt = ''
) {
	return regionId(regionIdentity(compRel, mark), salt);
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		root: ROOT,
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		virtualPathFor: (_hostId: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
		wrapperPathFor: (_hostId: string, iid: string) => wrapperVirtualId(iid),
		devUrlFor: (p: string) => '/@id/' + p,
		visibleMargin: '0px',
		presets: {},
		...overrides
	};
}

type Result = NonNullable<ReturnType<typeof transformHost>>;

function run(src: string, ctx = makeCtx()): Result | null {
	return transformHost(src, HOST, ctx);
}

function wrap(imports: string, markup: string): string {
	return `<script>\n${imports}\n</script>\n${markup}`;
}

function expectThrows(fn: () => unknown, re: RegExp): string {
	let msg = '';
	let threw = false;
	try {
		fn();
	} catch (e) {
		threw = true;
		msg = (e as Error).message;
	}
	expect(threw, 'expected a build error').toBe(true);
	expect(msg).toMatch(re);
	return msg;
}

const LOAD = `import C from './C.svelte' with { hydrate: 'load' };`;
const C_REL = 'src/routes/C.svelte';
const loadMark = { strategy: 'load', options: {} };

describe('normalize_import_keys', () => {
	test('defaults', () => {
		expect(normalize_import_keys()).toEqual({
			hydrate: 'hydrate',
			defer: 'defer',
			preset: 'preset'
		});
	});
	test('rejects collisions', () => {
		expect(() => normalize_import_keys({ hydrate: 'x', defer: 'x' })).toThrow(/distinct/);
	});
});

describe('strategyKey / regionIdentity dedupe', () => {
	test('same path + load → same id', () => {
		const a = idFor('src/lib/A.svelte', loadMark);
		const b = idFor('src/lib/A.svelte', { strategy: 'load', options: {} });
		expect(a).toBe(b);
	});
	test('different strategies → different ids', () => {
		expect(idFor('src/lib/A.svelte', loadMark)).not.toBe(
			idFor('src/lib/A.svelte', { strategy: 'visible', options: { margin: '0px' } })
		);
	});
	test('strategyKey encodes defer+hydrate combo', () => {
		expect(
			strategyKey({
				strategy: 'server',
				options: { when: 'idle', hydrate: 'visible', hydrateMargin: '10px' }
			})
		).toBe('defer:idle+hydrate:visible:hmargin:10px');
	});
});

describe('portable binding rewrite', () => {
	test('marked import becomes wrapper virtual; template keeps <C />', () => {
		const r = run(wrap(LOAD, '<C />'))!;
		const iid = idFor(C_REL, loadMark);
		expect(r.code).toMatch(
			new RegExp(`import C from ["']${wrapperVirtualId(iid).replace(/\./g, '\\.')}["']`)
		);
		expect(r.code).toMatch(/<C\s*\/>/);
		expect(r.code).not.toMatch(/OgygiaIsland__Wrapper/);
		expect(r.code).not.toMatch(/with \{ hydrate/);
		expect(r.islands).toHaveLength(1);
		expect(r.islands[0].id).toBe(iid);
		expect(r.islands[0].virtualPath).toBe(`virtual:ogygia/island/${iid}.js`);
		expect(r.islands[0].wrapperPath).toBe(wrapperVirtualId(iid));
		expect(r.islands[0].kind).toBe('hydrate');
		expect(r.islands[0].source).toMatch(/export default __OgygiaComp_/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaIsland__Wrapper load/);
		expect(r.islands[0].wrapperSource).toMatch(
			new RegExp(`__entry=\\{${JSON.stringify(islandPublicUrl(iid)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`)
		);
	});

	test('idle / visible / media strategies bake into wrapper', () => {
		const cases: Array<[string, RegExp]> = [
			['idle', /OgygiaIsland__Wrapper idle /],
			['visible', /OgygiaIsland__Wrapper visible="0px"/],
			['(min-width: 768px)', /OgygiaIsland__Wrapper media="\(min-width: 768px\)"/]
		];
		for (const [val, re] of cases) {
			const r = run(wrap(`import C from './C.svelte' with { hydrate: '${val}' };`, '<C />'))!;
			expect(r.islands[0].wrapperSource).toMatch(re);
		}
	});

	test('svelte:component this={C} is allowed', () => {
		const r = run(wrap(LOAD, '<svelte:component this={C} start={1} />'))!;
		expect(r.islands).toHaveLength(1);
		expect(r.code).toMatch(/svelte:component this=\{C\}/);
	});

	test('list + each of binding is allowed', () => {
		const r = run(
			wrap(
				`${LOAD}\nconst list = [{ comp: C, props: { n: 1 } }];`,
				'{#each list as item}<svelte:component this={item.comp} {...item.props} />{/each}'
			)
		)!;
		expect(r.islands).toHaveLength(1);
		expect(r.code).toMatch(/item\.comp/);
	});

	test('two static usages + dynamic + second import same path → ONE island entry', () => {
		const r = run(
			wrap(
				`import A from './A.svelte' with { hydrate: 'load' };\nimport B from './A.svelte' with { hydrate: 'load' };\nconst dyn = A;`,
				'<A n={1} /><A n={2} /><svelte:component this={dyn} n={3} /><B n={4} />'
			)
		)!;
		expect(r.islands).toHaveLength(1);
		const iid = idFor('src/routes/A.svelte', loadMark);
		expect(r.islands[0].id).toBe(iid);
		expect(r.code).toMatch(/import A from/);
		expect(r.code).toMatch(/import B from/);
		expect(r.code).toContain(wrapperVirtualId(iid));
	});

	test('csr=false client omit: many marked imports → stub bindings, still one emit metadata', () => {
		const imports = Array.from({ length: 20 }, (_, i) =>
			`import C${i} from './A.svelte' with { hydrate: 'load' };`
		).join('\n');
		const markup = Array.from({ length: 20 }, (_, i) => `<C${i} n={${i}} />`).join('');
		const r = run(wrap(imports, markup), makeCtx({ linkVirtualIsland: false }))!;
		expect(r.islands).toHaveLength(1);
		expect(r.code).not.toMatch(/virtual:ogygia\/wrapper\//);
		expect(r.code).not.toMatch(/virtual:ogygia\/island\//);
		expect(r.code.match(new RegExp(CLIENT_BINDING_STUB.replace(/\./g, '\\.'), 'g'))?.length).toBe(
			20
		);
		// FOUC: one deduped entry `__css`-style import so Kit still links island CSS.
		expect(r.code.match(/import __OgygiaFouc_C0 from ["']\.\/A\.svelte["'];/g)?.length).toBe(1);
		expect(r.code).toContain('void __OgygiaFouc_C0;');
		expect(r.islands[0].wrapperPath).toBe(
			wrapperVirtualId(idFor('src/routes/A.svelte', loadMark))
		);
		expect(r.islands[0].virtualPath).toMatch(/^virtual:ogygia\/island\//);
	});

	test('csr=false client omit: keeps host __css-style entry import for FOUC CSS', () => {
		const r = run(
			wrap(`import Nav from '$lib/SideNav.svelte' with { hydrate: 'load' };`, '<Nav />'),
			makeCtx({ linkVirtualIsland: false })
		)!;
		expect(r.code).toContain(CLIENT_BINDING_STUB);
		expect(r.code).toContain(`import __OgygiaFouc_Nav from "$lib/SideNav.svelte";`);
		expect(r.code).toContain('void __OgygiaFouc_Nav;');
		expect(r.code).not.toMatch(/virtual:ogygia\/wrapper\//);
	});

	test('linkVirtualIsland true (default) still rewrites to wrapper', () => {
		const r = run(wrap(LOAD, '<C />'), makeCtx({ linkVirtualIsland: true }))!;
		expect(r.code).toContain(wrapperVirtualId(idFor(C_REL, loadMark)));
		expect(r.code).not.toContain(CLIENT_BINDING_STUB);
	});

	test('same component different strategies → two entries', () => {
		const r = run(
			wrap(
				`import A from './A.svelte' with { hydrate: 'load' };\nimport ALazy from './A.svelte' with { hydrate: 'visible' };`,
				'<A /><ALazy />'
			)
		)!;
		expect(r.islands).toHaveLength(2);
		const ids = new Set(r.islands.map((i) => i.id));
		expect(ids.size).toBe(2);
	});

	test('cross-host identity: same component path yields same id', () => {
		const mark = loadMark;
		const host2 = '/app/src/routes/about/+page.svelte';
		const r1 = run(wrap(`import C from '$lib/C.svelte' with { hydrate: 'load' };`, '<C />'))!;
		const r2 = transformHost(
			wrap(`import C from '$lib/C.svelte' with { hydrate: 'load' };`, '<C />'),
			host2,
			makeCtx()
		)!;
		expect(r1.islands[0].id).toBe(r2.islands[0].id);
		expect(r1.islands[0].id).toBe(idFor('src/lib/C.svelte', mark));
	});

	test('unused marked import is stripped', () => {
		const r = run(wrap(LOAD, '<p>no usage of C</p>'))!;
		expect(r.islands).toHaveLength(0);
		expect(r.code).not.toMatch(/import C from/);
	});

	test('host children on hydrate island are a build error', () => {
		expectThrows(() => run(wrap(LOAD, '<C><p>x</p></C>')), /host children\/snippets/);
	});

	test('dotted Menu.Item on marked import is a build error', () => {
		expectThrows(
			() =>
				run(wrap(`import Menu from './Menu.svelte' with { hydrate: 'load' };`, '<Menu.Item />')),
			/dotted tag/
		);
	});
});

describe('defer / server islands', () => {
	test('defer:load → ServerIsland wrapper + defer entry', () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'load' };`, '<G name="w" />'))!;
		const iid = idFor('src/routes/G.svelte', {
			strategy: 'server',
			options: { when: 'load' }
		});
		expect(r.islands[0].id).toBe(iid);
		expect(r.islands[0].kind).toBe('defer');
		expect(r.islands[0].server).toBe(true);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaServerIsland__Wrapper/);
		expect(r.islands[0].wrapperSource).toMatch(/__defer=\{"load"\}/);
		expect(r.code).toMatch(/<G name="w"/);
	});

	test('ogygiaFallback snippet stays at call site', () => {
		const r = run(
			wrap(
				`import G from './G.svelte' with { defer: 'load' };`,
				'<G>{#snippet ogygiaFallback()}<p>loading…</p>{/snippet}</G>'
			)
		)!;
		expect(r.code).toMatch(/\{#snippet ogygiaFallback\(\)\}/);
		expect(r.islands[0].wrapperSource).toMatch(/ogygiaFallback/);
	});

	test('non-fallback children on defer are an error', () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { defer: 'load' };`, '<G><p>x</p></G>')),
			/host children/
		);
	});

	test('defer+hydrate combo', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { defer: 'idle', hydrate: 'load' };`, '<C />')
		)!;
		expect(r.islands[0].kind).toBe('hydrate');
		expect(r.islands[0].server).toBe(true);
		expect(r.islands[0].wrapperSource).toMatch(/__hydrate=\{"load"\}/);
		expect(r.islands[0].wrapperSource).toMatch(/__module=/);
	});

	test("defer: 'true' retired", () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { defer: 'true' };`, '<G />')),
			/`defer: 'true'` is no longer valid/
		);
	});
});

describe('lakes', () => {
	test('hydrate:none → lake wrapper binding', () => {
		const r = run(wrap(`import L from './L.svelte' with { hydrate: 'none' };`, '<L />'))!;
		expect(r.islands).toHaveLength(1);
		expect(r.islands[0].kind).toBe('lake');
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaLakeRegion__Wrapper/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaLakeInner/);
		expect(r.islands[0].lakes).toEqual(['OgygiaLakeInner']);
		expect(r.code).toMatch(/virtual:ogygia\/wrapper\//);
	});

	test('swr lake gets server entry module', () => {
		const r = run(
			wrap(`import L from './L.svelte' with { preset: 'frozenSwr' };`, '<L />'),
			makeCtx({
				presets: { frozenSwr: { hydrate: 'none', remount: 'swr' } }
			})
		)!;
		expect(r.islands[0].server).toBe(true);
		expect(r.islands[0].virtualPath).toMatch(/virtual:ogygia\/island\//);
		expect(r.islands[0].source).toMatch(/export default __OgygiaComp_/);
	});

	test('swr lake with children is an error', () => {
		expectThrows(
			() =>
				run(
					wrap(`import L from './L.svelte' with { preset: 'swr' };`, '<L><p>x</p></L>'),
					makeCtx({ presets: { swr: { hydrate: 'none', remount: 'swr' } } })
				),
			/cannot have children/
		);
	});
});

describe('presets', () => {
	test('preset expands to strategy on wrapper', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { preset: 'lazy' };`, '<C />'),
			makeCtx({ presets: { lazy: { hydrate: 'visible', margin: '200px' } } })
		)!;
		expect(r.islands[0].wrapperSource).toMatch(/visible="200px"/);
	});
});

describe('errors', () => {
	test("hydrate: 'false' suggests none", () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { hydrate: 'false' };`, '<C />')),
			/hydrate: 'false'.*hydrate: 'none'/i
		);
	});
	test('unknown strategy', () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { hydrate: 'sometimes' };`, '<C />')),
			/unknown hydrate strategy/
		);
	});
	test('dynamic import with region keys', () => {
		expectThrows(
			() =>
				run(
					wrap(
						`async function go() { await import('./C.svelte', { with: { hydrate: 'load' } }); }`,
						''
					)
				),
			/dynamic import\(\) with/
		);
	});
});

describe('entry module shape', () => {
	test('entry is a JS re-export of the component (props stay on the host tag)', () => {
		const r = run(wrap(`${LOAD}\nlet n = 1;`, '<C start={n} />'))!;
		expect(r.islands[0].source).toMatch(
			new RegExp(
				`import __OgygiaComp_${r.islands[0].id} from ${JSON.stringify('/app/src/routes/C.svelte').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
			)
		);
		expect(r.islands[0].source).toMatch(`export default __OgygiaComp_${r.islands[0].id};`);
		expect(r.code).toMatch(/<C start=\{n\}/);
	});
});
