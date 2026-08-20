// Transform suite — portable binding rewrite (0.4.0). Asserts host import rewrites, wrapper/entry
// virtual modules, path+strategy dedupe, props/fallback/children rules, defer+hydrate, lakes,
// presets, and csr-independent emit metadata. Runs against built `../dist/compiler/transform.js`.

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
} from '../dist/compiler/transform.js';

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
			render: 'render',
			preset: 'preset',
			region: 'region'
		});
	});
	test('rejects collisions', () => {
		expect(() => normalize_import_keys({ wake: 'x', render: 'x' })).toThrow(/distinct/);
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
	test('strategyKey fingerprints cache ttl (a cached hole never dedupes onto a no-store one)', () => {
		const plain = strategyKey({ strategy: 'server', options: { when: 'load' } });
		const cached = strategyKey({ strategy: 'server', options: { when: 'load', cacheTtlSec: 3600 } });
		expect(plain).toBe('defer:load');
		expect(cached).toBe('defer:load:ttl:3600');
		expect(cached).not.toBe(plain);
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
		const r = run(wrap(`import G from './G.svelte' with { render: 'deferred' };`, '<G name="w" />'))!;
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
				`import G from './G.svelte' with { render: 'deferred' };`,
				'<G>{#snippet ogygiaFallback()}<p>loading…</p>{/snippet}</G>'
			)
		)!;
		expect(r.code).toMatch(/\{#snippet ogygiaFallback\(\)\}/);
		expect(r.islands[0].wrapperSource).toMatch(/ogygiaFallback/);
	});

	test('non-fallback children on defer are an error', () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { render: 'deferred' };`, '<G><p>x</p></G>')),
			/host children/
		);
	});

	test('render: deferred is content-only (never hydrates)', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { render: 'deferred', wake: 'idle' };`, '<C />')
		)!;
		expect(r.islands[0].kind).toBe('defer');
		expect(r.islands[0].server).toBe(true);
		expect(r.islands[0].wrapperSource).toMatch(/__defer=\{"idle"\}/);
		// content-only: no client hydrate module is emitted
		expect(r.islands[0].wrapperSource).not.toMatch(/__hydrate=/);
	});

	test('a deferred hole must fetch (wake: none is rejected)', () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { render: 'deferred', wake: 'none' };`, '<G />')),
			/a hole must fetch/
		);
	});

	test('deferred is no-store by default (no __cacheTtl emitted)', () => {
		const r = run(wrap(`import C from './C.svelte' with { render: 'deferred' };`, '<C />'))!;
		expect(r.islands[0].wrapperSource).not.toMatch(/__cacheTtl/);
	});

	test('preset maxAge → __cacheTtl in seconds (duration string)', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { preset: 'cached' };`, '<C />'),
			makeCtx({ presets: { cached: { render: 'deferred', maxAge: '1h' } } })
		)!;
		expect(r.islands[0].wrapperSource).toMatch(/__cacheTtl=\{3600\}/);
	});

	test('preset maxAge → __cacheTtl in seconds (bare number is seconds)', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { preset: 'cached' };`, '<C />'),
			makeCtx({ presets: { cached: { render: 'deferred', maxAge: 45 } } })
		)!;
		expect(r.islands[0].wrapperSource).toMatch(/__cacheTtl=\{45\}/);
	});

	test('preset maxAge: 0 stays no-store (no __cacheTtl)', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { preset: 'fresh' };`, '<C />'),
			makeCtx({ presets: { fresh: { render: 'deferred', maxAge: 0 } } })
		)!;
		expect(r.islands[0].wrapperSource).not.toMatch(/__cacheTtl/);
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

	test('render: live gets a server entry module (baked + revalidate)', () => {
		const r = run(
			wrap(`import L from './L.svelte' with { preset: 'liveBox' };`, '<L />'),
			makeCtx({
				presets: { liveBox: { render: 'live' } }
			})
		)!;
		expect(r.islands[0].server).toBe(true);
		expect(r.islands[0].virtualPath).toMatch(/virtual:ogygia\/island\//);
		expect(r.islands[0].source).toMatch(/export default __OgygiaComp_/);
	});

	test('render: live with children is an error (revalidate endpoint re-renders from props)', () => {
		expectThrows(
			() =>
				run(
					wrap(`import L from './L.svelte' with { render: 'live' };`, '<L><p>x</p></L>')
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
// Cross-island children — host children cross a hydrate island at RUNTIME, not compile time.
// The compiler leaves the call site alone: children stay in the host markup and flow through the
// wrapper into Region's slot; the server renders them IN-PLACE inside a `<ogygia-slot>` marker and
// the payload carries a slot POINTER the client revives into an adopting snippet (region-snippet.ts).
// Nested islands inside render as full regions (SlotBoundary resets the nested context) and wake
// independently. This suite guards that the compiler does NOTHING special for children.
// ─────────────────────────────────────────────────────────────────────────────
describe('cross-island children (runtime slot crossing)', () => {
	const entryOf = (r: Result) => r.islands[0]?.virtualPath ?? '';
	const synthOf = (r: Result) => r.islands[0]?.source ?? '';

	test('children stay at the call site; the entry is the plain .js re-export', () => {
		const r = run(wrap(LOAD, '<C><p>x</p></C>'))!;
		expect(entryOf(r)).toMatch(/\.js$/);
		expect(synthOf(r)).toMatch(/export default __OgygiaComp_/);
		// the host tag keeps its children — the wrapper forwards them into Region's slot
		expect(r.code).toMatch(/<C\s*><p>x<\/p><\/C>/);
	});

	test('a plain island (no children) compiles identically', () => {
		const r = run(wrap(LOAD, '<C />'))!;
		expect(entryOf(r)).toMatch(/\.js$/);
		expect(synthOf(r)).toMatch(/export default __OgygiaComp_/);
	});

	test('children do not change the region id — one island either way', () => {
		const withKids = run(wrap(LOAD, '<C><p>x</p></C>'))!;
		const noKids = run(wrap(LOAD, '<C />'))!;
		expect(withKids.islands).toHaveLength(1);
		expect(withKids.islands[0].id).toBe(noKids.islands[0].id);
	});

	test('many call sites with different children share the ONE island', () => {
		const r = run(wrap(LOAD, '<C><p>a</p></C>\n<C><p>b</p></C>\n<C><p>a</p></C>'))!;
		expect(r.islands).toHaveLength(1);
		// no synthetic per-usage bindings — every usage keeps the real import
		expect(r.code).not.toMatch(/__og\d/);
	});

	test('host values referenced by children need no capture wiring (server closure renders them)', () => {
		const r = run(wrap(LOAD + '\nconst who = "Ada";', '<C><p>{who}</p></C>'))!;
		expect(r.code).not.toMatch(/__ogFv/);
		expect(r.code).toMatch(/<p>\{who\}<\/p>/);
	});

	test('a nested marked island inside children keeps its OWN region (wakes independently)', () => {
		const r = run(
			wrap(LOAD + `\nimport B from './B.svelte' with { wake: 'load' };`, '<C><B start={5} /></C>')
		)!;
		expect(r.islands).toHaveLength(2);
		expect(r.code).toMatch(/<B start=\{5\} \/>/);
	});

	test('a server island still rejects host children (only the fallback snippet crosses)', () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { render: 'deferred' };`, '<G><p>x</p></G>')),
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

	test("render: deferred + wake: 'interaction' is rejected (a hole can't fetch on interaction)", () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { render: 'deferred', wake: 'interaction' };`, '<G />')),
			/fetches on the .*wake.* schedule/
		);
	});

	test('interaction island can carry crossed children (runtime slot, plain entry)', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { wake: 'interaction' };`, '<C><p>x</p></C>')
		)!;
		expect(r.islands[0].virtualPath).toMatch(/\.js$/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" interaction /);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// continuity: keep — `with { keep: 'name' }` keeps the live island across SPA nav.
// ─────────────────────────────────────────────────────────────────────────────
describe('keep attribute', () => {
	test("hydrate + keep → wrapper passes __keep", () => {
		const r = run(wrap(`import P from './P.svelte' with { wake: 'load', keep: 'player' };`, '<P />'))!;
		expect(r.islands[0].wrapperSource).toMatch(/__keep=\{"player"\}/);
		// keep rides on the hydrate strategy (still a load island)
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" load/);
	});

	test('keep alone (default load schedule) is allowed', () => {
		const r = run(wrap(`import P from './P.svelte' with { wake: 'visible', keep: 'x' };`, '<P />'))!;
		expect(r.islands[0].wrapperSource).toMatch(/__keep=\{"x"\}/);
		expect(r.islands[0].wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="island" visible/);
	});

	test('empty keep name is a build error', () => {
		expectThrows(
			() => run(wrap(`import P from './P.svelte' with { wake: 'load', keep: '' };`, '<P />')),
			/keep.*non-empty name/
		);
	});

	test('keep in a preset works', () => {
		const ctx = makeCtx({ presets: { pl: { wake: 'load', keep: 'player' } } });
		const r = run(wrap(`import P from './P.svelte' with { preset: 'pl' };`, '<P />'), ctx)!;
		expect(r.islands[0].wrapperSource).toMatch(/__keep=\{"player"\}/);
	});
})

describe('portable snippets — a named snippet handed to a non-island component', () => {
	const portableIslands = (r: Result) => r.islands.filter((i) => (i as { portable?: boolean }).portable);

	test('is rewritten to og_portable + emits a hydrate entry', () => {
		const r = run(wrap(`import Shell from './Shell.svelte';`, `<Shell>{#snippet actions()}<a href="#">GH</a>{/snippet}</Shell>`))!;
		expect(r.code).toMatch(/og_portable/);
		expect(r.code).toMatch(/actions=\{__og_portable\(/);
		expect(portableIslands(r).length).toBe(1);
	});

	test('captured host value is passed to the entry as a prop', () => {
		const r = run(wrap(`import Shell from './Shell.svelte';\nconst who = 'Ada';`, `<Shell>{#snippet actions()}<a>{who}</a>{/snippet}</Shell>`))!;
		// og_portable receives { who } and the entry destructures it.
		expect(r.code).toMatch(/__og_portable\(\s*[^,]+,\s*\{ who \}/);
		expect(portableIslands(r)[0].source).toMatch(/let \{ who \} = \$props\(\)/);
	});

	test('two identical snippets dedupe to ONE entry + ONE import', () => {
		const src = wrap(`import Shell from './Shell.svelte';`, `<Shell>{#snippet a()}<a>x</a>{/snippet}</Shell>\n<Shell>{#snippet b()}<a>x</a>{/snippet}</Shell>`);
		const r = run(src, makeCtx({ ssr: true }))!;
		expect(portableIslands(r).length).toBe(1);
		expect((r.code.match(/import __OgPS_/g) || []).length).toBe(1);
	});

	test('SSR emits a static entry import; the csr=false client loads by url', () => {
		const src = wrap(`import Shell from './Shell.svelte';`, `<Shell>{#snippet actions()}<a>x</a>{/snippet}</Shell>`);
		const ssr = run(src, makeCtx({ ssr: true }))!;
		expect(ssr.code).toMatch(/import __OgPS_[a-f0-9]+ from/);
		expect(ssr.code).toMatch(/__og_portable\(__OgPS_/);
		const client = run(src, makeCtx({ ssr: false }))!;
		expect(client.code).not.toMatch(/import __OgPS_/);
		expect(client.code).toMatch(/__og_portable\(null,/);
	});

	test('a parameterized snippet on a PLAIN component stays native (library-internal wiring)', () => {
		// Branding isolates the snippet body from the surrounding tree (getContext breaks) — think
		// Bits UI passing `{#snippet x(props)}` between its own context-coupled components.
		const r = run(wrap(`import Shell from './Shell.svelte';`, `<Shell>{#snippet row(item)}<li>{item}</li>{/snippet}</Shell>`));
		expect(r?.code ?? '').not.toMatch(/og_portable/);
	});

	test('a parameterized snippet at an ISLAND call site compiles portable — args ride __ogArgs', () => {
		const r = run(wrap(LOAD, `<C>{#snippet row(item)}<li>{item}</li>{/snippet}</C>`))!;
		expect(r.code).toMatch(/row=\{__og_portable\(/);
		const entry = r.islands.find((i) => (i as { portable?: boolean }).portable)!;
		// the entry re-binds the params from the __ogArgs prop; `item` is never a capture
		expect(entry.source).toMatch(/let \{ __ogArgs = \[\] \} = \$props\(\);/);
		expect(entry.source).toMatch(/const \[item\] = __ogArgs;/);
	});

	test('node_modules-swept sources are never portable-branded (bits-ui safety)', () => {
		const src = wrap(`import Shell from './Shell.svelte';`, `<Shell>{#snippet header()}<em>x</em>{/snippet}</Shell>`);
		const r = transformHost(src, '/app/node_modules/some-lib/dist/Widget.svelte', makeCtx());
		expect(r?.code ?? '').not.toMatch(/og_portable/);
	});

	test('a snippet that writes host state is left native (a snapshot can’t write back)', () => {
		const r = run(wrap(`import Shell from './Shell.svelte';\nlet count = $state(0);`, `<Shell>{#snippet actions()}<button onclick={() => count++}>{count}</button>{/snippet}</Shell>`));
		expect(r?.code ?? '').not.toMatch(/og_portable/);
	});

	test('a named snippet handed to an ISLAND call site compiles portable too (live crossing)', () => {
		const r = run(wrap(LOAD, `<C>{#snippet actions()}<a>x</a>{/snippet}</C>`))!;
		expect(r.code).toMatch(/actions=\{__og_portable\(/);
		// the island itself + the portable entry
		expect(r.islands.length).toBe(2);
	});

	test('SSR emits NO static modulepreload — the hint is render-gated in Region.svelte', () => {
		// The old static scan preloaded every portable CANDIDATE in the host, rendered or not (an
		// opted-out snippet still cost a head link + fetch). The no-waterfall hint now comes from
		// Region.svelte when an island's props actually carry the descriptor. The transform's job
		// is only to thread the public entry url through og_portable for that render-time emission.
		const r = run(wrap(`import Shell from './Shell.svelte';`, `<Shell>{#snippet actions()}<a>x</a>{/snippet}</Shell>`), makeCtx({ ssr: true }))!;
		expect(r.code).not.toMatch(/<svelte:head><link rel="modulepreload"/);
		expect(r.code).toMatch(/__og_portable\([^)]*"\/_app\/immutable\/og-region\.[a-f0-9]+\.js"\)/);
	});

	test('a snippet-only file with no islands still transforms (relaxed bailout)', () => {
		const r = run(wrap(`import Shell from './Shell.svelte';`, `<Shell>{#snippet actions()}<a>x</a>{/snippet}</Shell>`));
		expect(r).not.toBeNull();
	});
})
;

describe('package-specifier island marks', () => {
	const PKG = `import TabGroup from 'ogygia/content/tab-group' with { wake: 'load' };`;
	const PKG_SPEC = 'ogygia/content/tab-group';

	test('a marked package import (no children) becomes an island keyed by the specifier', () => {
		const r = run(wrap(PKG, '<TabGroup />'))!;
		expect(r.islands).toHaveLength(1);
		const isl = r.islands[0];
		// identity IS the verbatim specifier (stable + shared across hosts), not a root-relative path
		expect(isl.id).toBe(idFor(PKG_SPEC, loadMark));
		expect(isl.componentPath).toBe(PKG_SPEC);
		// generated entry + wrapper RE-EMIT the original specifier for Vite to resolve
		expect(isl.source).toContain(`from "${PKG_SPEC}"`);
		expect(isl.wrapperSource).toContain(`from "${PKG_SPEC}"`);
	});

	test('children at the call site stay put — the package island crosses them at runtime', () => {
		const src = wrap(
			PKG + `\nimport { Tab } from 'ogygia/content';`,
			`<TabGroup group="install"><Tab label="npm"><p>x</p></Tab></TabGroup>`
		);
		const r = run(src)!;
		expect(r.islands).toHaveLength(1);
		const isl = r.islands[0];
		// plain .js re-export entry — no synthesized wrapper component
		expect(isl.virtualPath).toMatch(/\.js$/);
		expect(isl.source).toContain(`from "${PKG_SPEC}"`);
		// host tag untouched: real import name, children in place (they flow through the wrapper's slot)
		expect(r.code).toMatch(/<TabGroup group="install"><Tab label="npm"><p>x<\/p><\/Tab><\/TabGroup>/);
		expect(r.code).not.toMatch(/__og\d/);
		// the plain named package import (Tab) rides along untouched
		expect(r.code).toContain(`import { Tab } from 'ogygia/content';`);
	});

	test('two hosts marking the same package specifier share one region id', () => {
		const a = transformHost(wrap(PKG, '<TabGroup />'), '/app/src/routes/a/+page.svelte', makeCtx())!;
		const b = transformHost(wrap(PKG, '<TabGroup />'), '/app/src/routes/deep/b/+page.svelte', makeCtx())!;
		expect(a.islands[0].id).toBe(b.islands[0].id);
	});

	test('package islands with children share one id across hosts (children no longer key the id)', () => {
		const src = (host: string) =>
			transformHost(
				wrap(
					PKG + `\nimport { Tab } from 'ogygia/content';`,
					`<TabGroup group="pm"><Tab label="npm"><p>i</p></Tab></TabGroup>`
				),
				host,
				makeCtx()
			)!;
		const a = src('/app/src/content/one.md');
		const b = src('/app/src/content/two.md');
		expect(a.islands[0].id).toBe(b.islands[0].id);
	});

	test('csr=false client host: package island skips the fouc-css side-effect import (needs a real path)', () => {
		const r = transformHost(wrap(PKG, '<TabGroup />'), HOST, makeCtx({ linkVirtualIsland: false }))!;
		expect(r.code).toContain(CLIENT_BINDING_STUB);
		expect(r.code).not.toContain('virtual:ogygia/fouc-css');
		// a relative island on the same host still gets its fouc-css import
		const rel = run(wrap(LOAD, '<C />'), makeCtx({ linkVirtualIsland: false }))!;
		expect(rel.code).toContain(foucCssVirtualId(C_REL));
	});

	test('an empty specifier still errors loudly', () => {
		expectThrows(
			() => run(wrap(`import X from '' with { wake: 'load' };`, '<X />')),
			/needs a module specifier/
		);
	});
});

describe('asRegion macro (import.meta.og.asRegion)', () => {
	const asr = (script: string, markup: string) => run(wrap(script, markup))!;

	test('named barrel import → island; entry imports the NAMED export; template keeps <H/>', () => {
		const r = asr(
			`import { Header } from '@acme/ui';\nconst H = import.meta.og.asRegion(Header, 'load');`,
			'<H title="Hi" />'
		);
		const iid = idFor('@acme/ui#Header', loadMark);
		// the const is rewritten to a hoisted binding import; the tag stays <H … />
		expect(r.code).toMatch(
			new RegExp(`import H from ["']${wrapperVirtualId(iid).replace(/\./g, '\\.')}["']`)
		);
		expect(r.code).toMatch(/<H\s+title="Hi"\s*\/>/);
		expect(r.code).not.toMatch(/import\.meta\.og\.asRegion/);
		expect(r.islands).toHaveLength(1);
		const island = r.islands[0];
		expect(island.id).toBe(iid);
		expect(island.source).toMatch(/import \{ Header as __OgygiaComp_[0-9a-f]+ \} from ["']@acme\/ui["']/);
		expect(island.source).toMatch(/export default __OgygiaComp_/);
		// wrapper's CSS-linkage import is named too (else a barrel has no default to pull)
		expect(island.wrapperSource).toMatch(/import \{ Header as __OgygiaCss \} from ["']@acme\/ui["']/);
	});

	test('identity keys on source#exportName: two named exports of ONE barrel → two islands', () => {
		const r = asr(
			`import { Header, Footer } from '@acme/ui';\n` +
				`const H = import.meta.og.asRegion(Header, 'load');\n` +
				`const F = import.meta.og.asRegion(Footer, 'visible');`,
			'<H /><F />'
		);
		expect(r.islands).toHaveLength(2);
		expect(new Set(r.islands.map((i) => i.id)).size).toBe(2);
		expect(r.islands.map((i) => i.id)).toContain(idFor('@acme/ui#Header', loadMark));
	});

	test('a default import works via asRegion too (default entry import)', () => {
		const r = asr(`import Card from './Card.svelte';\nconst C = import.meta.og.asRegion(Card, 'idle');`, '<C />');
		expect(r.islands).toHaveLength(1);
		expect(r.islands[0].source).toMatch(/import __OgygiaComp_[0-9a-f]+ from ["'][^"']*Card\.svelte["']/);
		expect(r.islands[0].source).not.toMatch(/import \{ /);
	});

	test('a fully-consumed barrel import is stripped from the host (no barrel in host chunk)', () => {
		const r = asr(`import { Header } from '@acme/ui';\nconst H = import.meta.og.asRegion(Header, 'load');`, '<H />');
		expect(r.code).not.toMatch(/from ['"]@acme\/ui['"]/);
	});

	test('a barrel import with a still-used non-component export is KEPT', () => {
		const r = asr(
			`import { Header, brand } from '@acme/ui';\nconst H = import.meta.og.asRegion(Header, 'load');`,
			'<H />{brand}'
		);
		expect(r.code).toMatch(/from ['"]@acme\/ui['"]/); // brand still referenced → import stays
	});

	// ── misuse: loud build errors ────────────────────────────────────────────────
	test('first arg not an imported component → error', () => {
		expectThrows(
			() => asr(`const H = import.meta.og.asRegion(NotImported, 'load');`, '<H />'),
			/not an imported component/
		);
	});
	test('namespace import → error', () => {
		expectThrows(
			() => asr(`import * as UI from '@acme/ui';\nconst H = import.meta.og.asRegion(UI, 'load');`, '<H />'),
			/namespace import/
		);
	});
	test('`let` binding → error (must be const)', () => {
		expectThrows(
			() => asr(`import { Header } from '@acme/ui';\nlet H = import.meta.og.asRegion(Header, 'load');`, '<H />'),
			/must be bound with `const`/
		);
	});
	test('double-marked (import attribute AND asRegion) → error', () => {
		expectThrows(
			() =>
				asr(
					`import Header from './Header.svelte' with { wake: 'load' };\nconst H = import.meta.og.asRegion(Header, 'idle');`,
					'<H />'
				),
			/already marked an island/
		);
	});
	test('unknown timing → error', () => {
		expectThrows(
			() => asr(`import { Header } from '@acme/ui';\nconst H = import.meta.og.asRegion(Header, 'whenever');`, '<H />'),
			/unknown wake/
		);
	});
	test('mixed declarators in one statement → error', () => {
		expectThrows(
			() =>
				asr(`import { Header } from '@acme/ui';\nconst x = 1, H = import.meta.og.asRegion(Header, 'load');`, '<H />'),
			/its own `const/
		);
	});
	test('NOT top-level (nested in a function) → error', () => {
		expectThrows(
			() =>
				asr(
					`import { Header } from '@acme/ui';\nfunction make() { const H = import.meta.og.asRegion(Header, 'load'); return H; }`,
					'<div />'
				),
			/must be a top-level/
		);
	});
	test('NOT top-level (in a for-loop block) → error', () => {
		expectThrows(
			() =>
				asr(
					`import { Header } from '@acme/ui';\nfor (let i = 0; i < 2; i++) { const H = import.meta.og.asRegion(Header, 'load'); }`,
					'<div />'
				),
			/must be a top-level/
		);
	});
});
