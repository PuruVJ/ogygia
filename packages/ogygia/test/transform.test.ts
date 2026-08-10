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
	regionBindingVirtualId,
	CLIENT_BINDING_STUB,
	foucCssVirtualId
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

const LOAD = `import C from './C.svelte' with { wake: 'load' };`;
const C_REL = 'src/routes/C.svelte';
const loadMark = { strategy: 'load', options: {} };

describe('normalize_import_keys', () => {
	test('defaults', () => {
		expect(normalize_import_keys()).toEqual({
			wake: 'wake',
			fill: 'fill',
			preset: 'preset',
			region: 'region'
		});
	});
	test('rejects collisions', () => {
		expect(() => normalize_import_keys({ wake: 'x', fill: 'x' })).toThrow(/distinct/);
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

describe('foucCssVirtualId', () => {
	test('builds .js virtual FOUC CSS ids (encoded path)', () => {
		expect(foucCssVirtualId('src/lib/SideNav.svelte')).toBe(
			'virtual:ogygia/fouc-css/' + encodeURIComponent('src/lib/SideNav.svelte') + '.js'
		);
		expect(foucCssVirtualId('src\\routes\\A.svelte')).toBe(
			'virtual:ogygia/fouc-css/' + encodeURIComponent('src/routes/A.svelte') + '.js'
		);
		expect(foucCssVirtualId('src/lib/SideNav.svelte').endsWith('.js')).toBe(true);
	});
});

describe('portable binding rewrite', () => {
	test('marked import becomes wrapper virtual; template keeps <C />', () => {
		const r = run(wrap(LOAD, '<C />'))!;
		const iid = idFor(C_REL, loadMark);
		// A wake import lands on the ATTACH BINDING (placeable + holdable); the wrapper still exists.
		expect(r.code).toMatch(
			new RegExp(`import C from ["']${regionBindingVirtualId(iid).replace(/\./g, '\\.')}["']`)
		);
		expect(r.code).toMatch(/<C\s*\/>/);
		expect(r.code).not.toMatch(/OgygiaRegion__Wrapper/);
		expect(r.code).not.toMatch(/with \{ hydrate/);
		expect(r.islands).toHaveLength(1);
		expect(r.islands[0].id).toBe(iid);
		expect(r.islands[0].virtualPath).toBe(`virtual:ogygia/island/${iid}.js`);
		expect(r.islands[0].wrapperPath).toBe(wrapperVirtualId(iid));
		expect(r.islands[0].bindingPath).toBe(regionBindingVirtualId(iid));
		// SSR leg attaches the descriptor onto the wrapper; client leg is metadata-only.
		expect(String(r.islands[0].bindingSsrSource)).toMatch(/Object\.assign\(__OgygiaWrap/);
		expect(String(r.islands[0].bindingSsrSource)).toContain('__hydrate: "load"');
		expect(String(r.islands[0].bindingClientSource)).not.toContain('makeRegionEndpoint');
		expect(r.islands[0].kind).toBe('hydrate');
		expect(r.islands[0].source).toMatch(/export default __OgygiaComp_/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" load/);
		expect(r.islands[0].wrapperSource).toMatch(
			new RegExp(`__entry=\\{${JSON.stringify(islandPublicUrl(iid)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`)
		);
	});

	test('idle / visible / media strategies bake into wrapper', () => {
		const cases: Array<[string, RegExp]> = [
			['idle', /OgygiaRegion__Wrapper __mode="island" idle /],
			['visible', /OgygiaRegion__Wrapper __mode="island" visible="0px"/],
			['(min-width: 768px)', /OgygiaRegion__Wrapper __mode="island" media="\(min-width: 768px\)"/]
		];
		for (const [val, re] of cases) {
			const r = run(wrap(`import C from './C.svelte' with { wake: '${val}' };`, '<C />'))!;
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
				`import A from './A.svelte' with { wake: 'load' };\nimport B from './A.svelte' with { wake: 'load' };\nconst dyn = A;`,
				'<A n={1} /><A n={2} /><svelte:component this={dyn} n={3} /><B n={4} />'
			)
		)!;
		expect(r.islands).toHaveLength(1);
		const iid = idFor('src/routes/A.svelte', loadMark);
		expect(r.islands[0].id).toBe(iid);
		expect(r.code).toMatch(/import A from/);
		expect(r.code).toMatch(/import B from/);
		expect(r.code).toContain(regionBindingVirtualId(iid));
		expect(r.islands[0].wrapperPath).toBe(wrapperVirtualId(iid));
	});

	test('csr=false client omit: many marked imports → stub bindings, still one emit metadata', () => {
		const imports = Array.from({ length: 20 }, (_, i) =>
			`import C${i} from './A.svelte' with { wake: 'load' };`
		).join('\n');
		const markup = Array.from({ length: 20 }, (_, i) => `<C${i} n={${i}} />`).join('');
		const r = run(wrap(imports, markup), makeCtx({ linkVirtualIsland: false }))!;
		expect(r.islands).toHaveLength(1);
		expect(r.code).not.toMatch(/virtual:ogygia\/wrapper\//);
		expect(r.code).not.toMatch(/virtual:ogygia\/island\//);
		expect(r.code.match(new RegExp(CLIENT_BINDING_STUB.replace(/\./g, '\\.'), 'g'))?.length).toBe(
			20
		);
		// FOUC: one deduped CSS-only virtual (not the component JS default export).
		expect(
			r.code.match(
				new RegExp(
					`import ["']virtual:ogygia/fouc-css/${encodeURIComponent('src/routes/A.svelte')}\\.js["'];`,
					'g'
				)
			)?.length
		).toBe(1);
		expect(r.code).not.toMatch(/import __OgygiaFouc_/);
		expect(r.code).not.toMatch(/from ["']\.\/A\.svelte["']/);
		expect(r.islands[0].wrapperPath).toBe(
			wrapperVirtualId(idFor('src/routes/A.svelte', loadMark))
		);
		expect(r.islands[0].virtualPath).toMatch(/^virtual:ogygia\/island\//);
	});

	test('csr=false client omit: CSS-only fouc-css virtual for FOUC (not component JS)', () => {
		const r = run(
			wrap(`import Nav from '$lib/SideNav.svelte' with { wake: 'load' };`, '<Nav />'),
			makeCtx({ linkVirtualIsland: false })
		)!;
		expect(r.code).toContain(CLIENT_BINDING_STUB);
		expect(r.code).toContain(
			`import "virtual:ogygia/fouc-css/${encodeURIComponent('src/lib/SideNav.svelte')}.js";`
		);
		expect(r.code).not.toMatch(/from ["']\$lib\/SideNav\.svelte["']/);
		expect(r.code).not.toMatch(/virtual:ogygia\/wrapper\//);
	});

	test('linkVirtualIsland true (default) rewrites to the attach binding (not the stub)', () => {
		const r = run(wrap(LOAD, '<C />'), makeCtx({ linkVirtualIsland: true }))!;
		expect(r.code).toContain(regionBindingVirtualId(idFor(C_REL, loadMark)));
		expect(r.code).not.toContain(CLIENT_BINDING_STUB);
	});

	test('same component different strategies → two entries', () => {
		const r = run(
			wrap(
				`import A from './A.svelte' with { wake: 'load' };\nimport ALazy from './A.svelte' with { wake: 'visible' };`,
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
		const r1 = run(wrap(`import C from '$lib/C.svelte' with { wake: 'load' };`, '<C />'))!;
		const r2 = transformHost(
			wrap(`import C from '$lib/C.svelte' with { wake: 'load' };`, '<C />'),
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

	test('dotted Menu.Item on marked import is a build error', () => {
		expectThrows(
			() =>
				run(wrap(`import Menu from './Menu.svelte' with { wake: 'load' };`, '<Menu.Item />')),
			/dotted tag/
		);
	});
});

describe('defer / server islands', () => {
	test('defer:load → ServerIsland wrapper + defer entry', () => {
		const r = run(wrap(`import G from './G.svelte' with { fill: 'load' };`, '<G name="w" />'))!;
		const iid = idFor('src/routes/G.svelte', {
			strategy: 'server',
			options: { when: 'load' }
		});
		expect(r.islands[0].id).toBe(iid);
		expect(r.islands[0].kind).toBe('defer');
		expect(r.islands[0].server).toBe(true);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="server"/);
		expect(r.islands[0].wrapperSource).toMatch(/__defer=\{"load"\}/);
		expect(r.code).toMatch(/<G name="w"/);
	});

	test('ogygiaFallback snippet stays at call site', () => {
		const r = run(
			wrap(
				`import G from './G.svelte' with { fill: 'load' };`,
				'<G>{#snippet ogygiaFallback()}<p>loading…</p>{/snippet}</G>'
			)
		)!;
		expect(r.code).toMatch(/\{#snippet ogygiaFallback\(\)\}/);
		expect(r.islands[0].wrapperSource).toMatch(/ogygiaFallback/);
	});

	test('non-fallback children on defer are an error', () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { fill: 'load' };`, '<G><p>x</p></G>')),
			/host children/
		);
	});

	test('defer+hydrate combo', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { fill: 'idle', wake: 'load' };`, '<C />')
		)!;
		expect(r.islands[0].kind).toBe('hydrate');
		expect(r.islands[0].server).toBe(true);
		expect(r.islands[0].wrapperSource).toMatch(/__hydrate=\{"load"\}/);
		expect(r.islands[0].wrapperSource).toMatch(/__module=/);
	});

	test("fill: 'true' retired", () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { fill: 'true' };`, '<G />')),
			/`fill: 'true'` is no longer valid/
		);
	});
});

describe('lakes', () => {
	test('hydrate:none → lake wrapper binding', () => {
		const r = run(wrap(`import L from './L.svelte' with { wake: 'none' };`, '<L />'))!;
		expect(r.islands).toHaveLength(1);
		expect(r.islands[0].kind).toBe('lake');
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="lake"/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaLakeInner/);
		expect(r.islands[0].lakes).toEqual(['OgygiaLakeInner']);
		expect(r.code).toMatch(/virtual:ogygia\/wrapper\//);
	});

	test('swr lake gets server entry module', () => {
		const r = run(
			wrap(`import L from './L.svelte' with { preset: 'frozenSwr' };`, '<L />'),
			makeCtx({
				presets: { frozenSwr: { wake: 'none', remount: 'swr' } }
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
					makeCtx({ presets: { swr: { wake: 'none', remount: 'swr' } } })
				),
			/cannot have children/
		);
	});
});

describe('presets', () => {
	test('preset expands to strategy on wrapper', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { preset: 'lazy' };`, '<C />'),
			makeCtx({ presets: { lazy: { wake: 'visible', margin: '200px' } } })
		)!;
		expect(r.islands[0].wrapperSource).toMatch(/visible="200px"/);
	});
});

describe('errors', () => {
	test("wake: 'false' suggests none", () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { wake: 'false' };`, '<C />')),
			/wake: 'false'.*wake: 'none'/i
		);
	});
	test('unknown strategy', () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { wake: 'sometimes' };`, '<C />')),
			/unknown wake strategy/
		);
	});
	test('dynamic import with region keys', () => {
		expectThrows(
			() =>
				run(
					wrap(
						`async function go() { await import('./C.svelte', { with: { wake: 'load' } }); }`,
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

// ─────────────────────────────────────────────────────────────────────────────
// Cross-island composition — host children/snippets cross into a hydrate island.
// The compiler ships them as a synthesized `.svelte` entry that inlines the snippet and wraps the
// real component; captured host VALUES ride across as an `__ogFv` prop; host IMPORTS the snippet
// uses (e.g. a nested island) are re-imported into the synth; globals are left alone; a snippet
// that ASSIGNS to a host value is rejected. This is the suite that guards that whole surface.
// ─────────────────────────────────────────────────────────────────────────────
describe('cross-island children', () => {
	const entryOf = (r: Result) => r.islands[0]?.virtualPath ?? '';
	const synthOf = (r: Result) => r.islands[0]?.source ?? '';

	test('static children → synthesized .svelte entry inlining the real component', () => {
		const r = run(wrap(LOAD, '<C><p>x</p></C>'))!;
		expect(entryOf(r)).toMatch(/\.svelte$/);
		expect(synthOf(r)).toMatch(/import OgygiaChildTarget from/);
		expect(synthOf(r)).toMatch(/<OgygiaChildTarget \{\.\.\.__ogp\}><p>x<\/p><\/OgygiaChildTarget>/);
		// the manifest side-effect import ships so a transportable in the children still registers
		expect(synthOf(r)).toMatch(/import 'virtual:ogygia\/transportables'/);
	});

	test('a plain island (no children) keeps its .js re-export entry', () => {
		const r = run(wrap(LOAD, '<C />'))!;
		expect(entryOf(r)).toMatch(/\.js$/);
		expect(synthOf(r)).toMatch(/export default __OgygiaComp_/);
	});

	test('captured host value → __ogFv prop on the tag + destructure in the synth', () => {
		const r = run(wrap(LOAD + '\nconst who = "Ada";', '<C><p>{who}</p></C>'))!;
		expect(r.code).toMatch(/__ogFv=\{\{ who \}\}/);
		expect(synthOf(r)).toMatch(/const \{ who \} = __ogFv;/);
		expect(synthOf(r)).toMatch(/<p>\{who\}<\/p>/);
	});

	test('multiple captured values all ride __ogFv', () => {
		const r = run(wrap(LOAD + '\nconst a = 1;\nconst b = 2;', '<C><p>{a}{b}</p></C>'))!;
		expect(r.code).toMatch(/__ogFv=\{\{ (a, b|b, a) \}\}/);
		expect(synthOf(r)).toMatch(/const \{ (a, b|b, a) \} = __ogFv;/);
	});

	test('named snippet inlines verbatim into the synth', () => {
		const r = run(wrap(LOAD, '<C>{#snippet header()}<em>hi</em>{/snippet}</C>'))!;
		expect(synthOf(r)).toMatch(/\{#snippet header\(\)\}<em>hi<\/em>\{\/snippet\}/);
	});

	test('parameterized snippet inlines; its param is not captured', () => {
		const r = run(wrap(LOAD + '\nconst who = "A";', '<C>{#snippet row(item)}<li>{item}{who}</li>{/snippet}</C>'))!;
		expect(synthOf(r)).toMatch(/\{#snippet row\(item\)\}/);
		// `item` is snippet-local → not captured; `who` is captured
		expect(r.code).toMatch(/__ogFv=\{\{ who \}\}/);
		expect(r.code).not.toMatch(/item/);
	});

	test('nested island in children → synth re-imports it (unmarked) so it degrades + hydrates with the parent', () => {
		const r = run(
			wrap(
				LOAD + `\nimport B from './B.svelte' with { wake: 'load' };`,
				'<C><B start={5} /></C>'
			)
		)!;
		// re-imported into the synth WITHOUT the region attribute → renders inline (nested degrade)
		expect(synthOf(r)).toMatch(/import B from ['"]\.\/B\.svelte['"];/);
		expect(synthOf(r)).not.toMatch(/import B from[^\n]*with/);
		expect(synthOf(r)).toMatch(/<B start=\{5\} \/>/);
		// the parent island itself is the only emitted region (B has no separate entry here)
		expect(r.islands).toHaveLength(1);
	});

	test('a global reference is neither captured nor imported', () => {
		const r = run(wrap(LOAD, '<C><p>{Math.max(1, 2)}</p></C>'))!;
		expect(synthOf(r)).not.toMatch(/const \{ Math/);
		expect(r.code).not.toMatch(/__ogFv/);
		expect(synthOf(r)).toMatch(/\{Math\.max\(1, 2\)\}/);
	});

	test('distinct children → distinct region ids; identical children dedupe', () => {
		const a = run(wrap(LOAD, '<C><p>one</p></C>'))!;
		const b = run(wrap(LOAD, '<C><p>two</p></C>'))!;
		const c = run(wrap(LOAD, '<C><p>one</p></C>'))!;
		expect(a.islands[0].id).not.toBe(b.islands[0].id);
		expect(a.islands[0].id).toBe(c.islands[0].id);
	});

	test('a children id differs from the same component with no children', () => {
		const withKids = run(wrap(LOAD, '<C><p>x</p></C>'))!;
		const noKids = run(wrap(LOAD, '<C />'))!;
		expect(withKids.islands[0].id).not.toBe(noKids.islands[0].id);
	});

	test('the host tag keeps its real props; children are stripped from the host', () => {
		const r = run(wrap(LOAD, '<C title="hi"><p>x</p></C>'))!;
		// tag renamed to a synthetic per-usage binding; real props preserved; children gone
		expect(r.code).toMatch(/<C__og0 title="hi"/);
		expect(r.code).not.toMatch(/<C__og0[^>]*><p>x<\/p>/);
		expect(r.code).toMatch(/<\/C__og0>/);
	});

	test('one import composed at MANY call sites → distinct islands per children', () => {
		const r = run(wrap(LOAD, '<C><p>a</p></C>\n<C><p>b</p></C>\n<C><p>a</p></C>'))!;
		// three usages → three synthetic bindings, but identical children (a) dedupe to one island id
		expect(r.code).toMatch(/<C__og0/);
		expect(r.code).toMatch(/<C__og1/);
		expect(r.code).toMatch(/<C__og2/);
		const ids = new Set(r.islands.map((i) => i.id));
		expect(ids.size).toBe(2); // {a-children, b-children}
		expect(r.islands.every((i) => i.virtualPath.endsWith('.svelte'))).toBe(true);
	});

	test('plain usages and children usages of the same import coexist', () => {
		const r = run(wrap(LOAD, '<C />\n<C><p>x</p></C>'))!;
		// plain <C /> keeps its (attach) binding; the children usage gets a synthetic binding
		expect(r.code).toMatch(/import C from ["']virtual:ogygia\/region\//);
		expect(r.code).toMatch(/<C__og0/);
		expect(r.code).toMatch(/<C\s*\/>/);
		expect(r.islands.length).toBe(2);
	});

	// ---- guards ----
	test('a child that assigns to a host value (bind:) is rejected', () => {
		expectThrows(
			() => run(wrap(LOAD + '\nlet name = "x";', '<C><input bind:value={name} /></C>')),
			/assign to host value/
		);
	});

	test('the mutation error names the host file', () => {
		expectThrows(
			() => run(wrap(LOAD + '\nlet name = "x";', '<C><input bind:value={name} /></C>')),
			/src\/routes\/\+page\.svelte/
		);
	});

	test('a server island still rejects host children (only the fallback snippet crosses)', () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { fill: 'load' };`, '<G><p>x</p></G>')),
			/host children\/snippets/
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// wake: 'interaction' — wake on first pointer/key/focus inside the region, click replay.
// ─────────────────────────────────────────────────────────────────────────────
describe('interaction schedule', () => {
	test("wake: 'interaction' → wrapper attr + region kind hydrate", () => {
		const r = run(wrap(`import C from './C.svelte' with { wake: 'interaction' };`, '<C />'))!;
		expect(r.islands).toHaveLength(1);
		expect(r.islands[0].kind).toBe('hydrate');
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" interaction /);
	});

	test('interaction dedupes by path+strategy like any schedule', () => {
		const a = run(wrap(`import C from './C.svelte' with { wake: 'interaction' };`, '<C />'))!;
		const b = run(wrap(`import C from './C.svelte' with { wake: 'interaction' };`, '<C />'))!;
		const load = run(wrap(LOAD, '<C />'))!;
		expect(a.islands[0].id).toBe(b.islands[0].id);
		expect(a.islands[0].id).not.toBe(load.islands[0].id);
	});

	test('preset with hydrate: interaction works', () => {
		const ctx = makeCtx({ presets: { lazy: { wake: 'interaction' } } });
		const r = run(wrap(`import C from './C.svelte' with { preset: 'lazy' };`, '<C />'), ctx)!;
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" interaction /);
	});

	test('defer + hydrate: interaction (phase-2 wake after swap) is accepted', () => {
		const r = run(
			wrap(`import G from './G.svelte' with { fill: 'load', wake: 'interaction' };`, '<G />')
		)!;
		expect(r.islands[0].wrapperSource).toMatch(/__hydrate=\{"interaction"\}/);
	});

	test("fill: 'interaction' is rejected (fetch-timing has no interaction)", () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { fill: 'interaction' };`, '<G />')),
			/unknown fill timing 'interaction'/
		);
	});

	test('interaction island can carry crossed children', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { wake: 'interaction' };`, '<C><p>x</p></C>')
		)!;
		expect(r.islands[0].virtualPath).toMatch(/\.svelte$/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" interaction /);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// continuity: persist — `with { persist: 'name' }` keeps the live island across SPA nav.
// ─────────────────────────────────────────────────────────────────────────────
describe('persist attribute', () => {
	test("hydrate + persist → wrapper passes __persist", () => {
		const r = run(wrap(`import P from './P.svelte' with { wake: 'load', persist: 'player' };`, '<P />'))!;
		expect(r.islands[0].wrapperSource).toMatch(/__persist=\{"player"\}/);
		// persist rides on the hydrate strategy (still a load island)
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" load/);
	});

	test('persist alone (default load schedule) is allowed', () => {
		const r = run(wrap(`import P from './P.svelte' with { wake: 'visible', persist: 'x' };`, '<P />'))!;
		expect(r.islands[0].wrapperSource).toMatch(/__persist=\{"x"\}/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" visible/);
	});

	test('empty persist name is a build error', () => {
		expectThrows(
			() => run(wrap(`import P from './P.svelte' with { wake: 'load', persist: '' };`, '<P />')),
			/persist.*non-empty name/
		);
	});

	test('persist in a preset works', () => {
		const ctx = makeCtx({ presets: { pl: { wake: 'load', persist: 'player' } } });
		const r = run(wrap(`import P from './P.svelte' with { preset: 'pl' };`, '<P />'), ctx)!;
		expect(r.islands[0].wrapperSource).toMatch(/__persist=\{"player"\}/);
	});
})
