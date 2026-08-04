// Transform unit suite — table-driven, vitest. Asserts the EXACT transformed-host output, the
// generated island-module source, the island metadata (deterministic ids, kind, ordering, offsets),
// and the precise build-error messages produced by `transformHost`. Runs the BUILT transform
// (../dist/vite/transform.js); root `pnpm run check` builds the lib before invoking lib `check`,
// which runs `vitest run` over this file.
//
// Matrix (see TODO.md task 2): hydrate values, defer/server, preset semantics, multi-island
// determinism + offsets, captures (let/const/$state/module/each/await/@const/snippet-shadow/globals/
// unicode/$-prefixed/locally-shadowed-global), imports (default/named/aliased/namespace/type-only/
// $lib/relative/npm, only-referenced-copied, other-import attributes preserved), snippets
// (children/named/nested + cross-boundary + host-function), remote imports (import-copies, spreads,
// member chains), captured-var mutation guards, TS-in-expressions + lang propagation, and robustness
// (comments, CRLF, self-closing, idempotency, whitespace).

import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { transformHost } from '../dist/vite/transform.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ROOT = '/app';
const HOST = '/app/src/routes/+page.svelte';
const REL_HOST = 'src/routes/+page.svelte';

/** The transform's own island-id function, reproduced to assert determinism + stability. */
function idFor(index: number | string): string {
	return createHash('md5').update(`${REL_HOST}::${index}`).digest('hex').slice(0, 12);
}
function lakeIdFor(islandIndex: number, lakeIndex: number): string {
	return idFor(`lake:${islandIndex}:${lakeIndex}`);
}

interface Ctx {
	root: string;
	libDir: string;
	readFile: () => null;
	pathModule: typeof path;
	dev: boolean;
	virtualPathFor: (hostId: string, iid: string) => string;
	devUrlFor: (p: string) => string;
	visibleMargin?: string;
	presets: Record<string, Record<string, string>>;
}

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
	return {
		root: ROOT,
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		virtualPathFor: (hostId: string, iid: string) => path.join(path.dirname(hostId), '.ogygia', iid + '.svelte'),
		devUrlFor: (p: string) => '/' + path.relative(ROOT, p),
		visibleMargin: '0px',
		presets: {},
		...overrides
	};
}

type Result = ReturnType<typeof transformHost>;

function run(src: string, ctx: Ctx = makeCtx()): Result {
	return transformHost(src, HOST, ctx);
}

/** A `<script>…</script>` + markup host file. */
function wrap(imports: string, markup: string): string {
	return `<script>\n${imports}\n</script>\n${markup}`;
}
function wrapTs(imports: string, markup: string): string {
	return `<script lang="ts">\n${imports}\n</script>\n${markup}`;
}

/** Grab the single generated island module source (the first island that carries a `source`). */
function islandSource(r: Result): string {
	const isl = (r?.islands ?? []).find((i) => i.source);
	expect(isl, 'expected a generated island module').toBeTruthy();
	return isl!.source;
}

/** The `__props={{ … }}` object printed on the wrapper (capture list), or '' if none matched. */
function propsObject(code: string): string {
	const m = code.match(/__props=\{\{[^}]*\}\}/);
	return m ? m[0] : '';
}

/** Assert `fn` throws and its message matches `re`; returns the message for further assertions. */
function expectThrows(fn: () => unknown, re: RegExp): string {
	let msg = '';
	let threw = false;
	try {
		fn();
	} catch (e) {
		threw = true;
		msg = (e as Error).message;
	}
	expect(threw, 'expected a build error to be thrown').toBe(true);
	expect(msg).toMatch(re);
	return msg;
}

const LOAD = `import C from './C.svelte' with { hydrate: 'load' };`;

// ===========================================================================

describe('hydrate strategy values', () => {
	test('load -> bare `load` wrapper attr', () => {
		const r = run(wrap(LOAD, '<C />'));
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper load __entry=/);
		expect(r!.islands[0].kind).toBe('hydrate');
		expect(r!.islands[0].server).toBe(false);
	});

	test('idle -> bare `idle` wrapper attr', () => {
		const r = run(wrap(`import C from './C.svelte' with { hydrate: 'idle' };`, '<C />'));
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper idle __entry=/);
	});

	test('visible -> `visible="0px"` from global default margin', () => {
		const r = run(wrap(`import C from './C.svelte' with { hydrate: 'visible' };`, '<C />'));
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper visible="0px" __entry=/);
	});

	test('visible -> uses a custom global margin', () => {
		const r = run(wrap(`import C from './C.svelte' with { hydrate: 'visible' };`, '<C />'), makeCtx({ visibleMargin: '250px' }));
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper visible="250px" __entry=/);
	});

	test('media query -> `media="(query)"` wrapper attr', () => {
		const r = run(wrap(`import C from './C.svelte' with { hydrate: '(min-width: 768px)' };`, '<C />'));
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper media="\(min-width: 768px\)" __entry=/);
	});

	test('max-width media query', () => {
		const r = run(wrap(`import C from './C.svelte' with { hydrate: '(max-width: 600px)' };`, '<C />'));
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper media="\(max-width: 600px\)" __entry=/);
	});

	test("'none' in the shell -> lake no-op, plain component, import cleaned (with{} dropped)", () => {
		const r = run(wrap(`import L from './L.svelte' with { hydrate: 'none' };`, '<L />'));
		expect(r, 'expected a non-null result (import cleaned)').toBeTruthy();
		expect(r!.code).toMatch(/import L from '\.\/L\.svelte';/);
		expect(r!.code).not.toMatch(/with \{ hydrate/);
		expect(r!.code).not.toMatch(/OgygiaIsland__Wrapper/);
	});

	test("'false' is an error suggesting 'none'", () => {
		expectThrows(() => run(wrap(`import C from './C.svelte' with { hydrate: 'false' };`, '<C />')), /hydrate: 'false'.*use .*hydrate: 'none'/i);
	});

	test('unknown strategy is an error listing the valid values', () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { hydrate: 'sometimes' };`, '<C />')),
			/unknown hydrate strategy 'sometimes'.*'load'.*'idle'.*'visible'.*media query/s
		);
	});
});

describe('defer / server island (fetch-timing symmetry)', () => {
	test("defer: 'load' -> server island (ServerIsland wrapper, kind defer, server true, __defer load)", () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'load' };`, '<G name="w" />'));
		expect(r!.code).toMatch(/<OgygiaServerIsland__Wrapper __entry=/);
		expect(r!.code).toMatch(/__defer=\{"load"\}/);
		expect(r!.code).not.toMatch(/OgygiaIsland__Wrapper /);
		expect(r!.islands[0].kind).toBe('defer');
		expect(r!.islands[0].server).toBe(true);
	});

	const timings: Array<[string, string, RegExp]> = [
		['idle', 'idle', /__defer=\{"idle"\}/],
		['visible', 'visible', /__defer=\{"visible"\} __margin=\{"0px"\}/],
		['media query', '(min-width: 700px)', /__defer=\{"\(min-width: 700px\)"\}/]
	];
	for (const [label, value, re] of timings) {
		test(`defer: '${label}' -> server island carrying the __defer timing`, () => {
			const r = run(wrap(`import G from './G.svelte' with { defer: '${value}' };`, '<G />'));
			expect(r!.code).toMatch(/OgygiaServerIsland__Wrapper/);
			expect(r!.code).toMatch(re);
			expect(r!.islands[0].server).toBe(true);
		});
	}

	test("defer: 'visible' with a custom global margin threads the margin", () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'visible' };`, '<G />'), makeCtx({ visibleMargin: '300px' }));
		expect(r!.code).toMatch(/__defer=\{"visible"\} __margin=\{"300px"\}/);
	});

	test("defer: 'true' is retired — errors suggesting a timing value ('load')", () => {
		const msg = expectThrows(
			() => run(wrap(`import G from './G.svelte' with { defer: 'true' };`, '<G />')),
			/`defer: 'true'` is no longer valid/
		);
		expect(msg).toMatch(/defer: 'load'/);
	});

	test('defer: unknown timing errors, listing the valid values', () => {
		expectThrows(
			() => run(wrap(`import G from './G.svelte' with { defer: 'whenever' };`, '<G />')),
			/unknown defer timing 'whenever'.*'load'.*'idle'.*'visible'.*media query/s
		);
	});

	test('server island keeps `fallback` inline in the host + strips it from the island module', () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'load' };`, '<G name="w">{#snippet fallback()}<p>loading…</p>{/snippet}</G>'));
		expect(r!.code).toMatch(/<OgygiaServerIsland__Wrapper[^>]*>\{#snippet fallback\(\)\}<p>loading…<\/p>\{\/snippet\}<\/OgygiaServerIsland__Wrapper>/);
		expect(islandSource(r)).not.toMatch(/fallback/);
	});

	test('defer + hydrate together is a roadmap error', () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { defer: 'load', hydrate: 'load' };`, '<C />')),
			/`defer` \+ `hydrate` together is not yet supported \(roadmap/
		);
	});
});

describe('preset semantics', () => {
	const PRESET_CTX = makeCtx({
		presets: {
			chart: { hydrate: 'visible', margin: '200px' },
			lazy: { hydrate: 'load', margin: '999px' }, // margin inapplicable to load -> tolerated
			modal: { hydrate: 'idle' },
			srv: { defer: 'load' }
		}
	});

	test('applies: chart -> visible with its margin', () => {
		const r = run(wrap(`import C from './C.svelte' with { preset: 'chart' };`, '<C />'), PRESET_CTX);
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper visible="200px" __entry=/);
	});

	test('tolerant: an inapplicable margin on a `load` preset is ignored (not an error)', () => {
		const r = run(wrap(`import C from './C.svelte' with { preset: 'lazy' };`, '<C />'), PRESET_CTX);
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper load __entry=/);
	});

	test('modal -> idle', () => {
		const r = run(wrap(`import C from './C.svelte' with { preset: 'modal' };`, '<C />'), PRESET_CTX);
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper idle __entry=/);
	});

	test('srv -> server island', () => {
		const r = run(wrap(`import C from './C.svelte' with { preset: 'srv' };`, '<C />'), PRESET_CTX);
		expect(r!.code).toMatch(/OgygiaServerIsland__Wrapper/);
	});

	test('unknown name errors, listing the available presets', () => {
		const msg = expectThrows(() => run(wrap(`import C from './C.svelte' with { preset: 'nope' };`, '<C />'), PRESET_CTX), /unknown preset 'nope'/);
		expect(msg).toMatch(/chart/);
		expect(msg).toMatch(/lazy/);
		expect(msg).toMatch(/modal/);
		expect(msg).toMatch(/srv/);
	});

	test('unknown name with NO presets configured says "(none)"', () => {
		expectThrows(() => run(wrap(`import C from './C.svelte' with { preset: 'x' };`, '<C />')), /unknown preset 'x'.*\(none\)/s);
	});

	test('preset must be the ONLY import attribute (preset + another key errors)', () => {
		expectThrows(() => run(wrap(`import C from './C.svelte' with { preset: 'chart', hydrate: 'load' };`, '<C />'), PRESET_CTX), /`preset` must be the only import attribute/);
	});

	test('unknown key in a preset DEFINITION errors, naming the preset', () => {
		const ctx = makeCtx({ presets: { bad: { hydrate: 'load', wat: 'x' } } });
		expectThrows(() => run(wrap(`import C from './C.svelte' with { preset: 'bad' };`, '<C />'), ctx), /unknown key `wat` in preset 'bad'/);
	});
});

describe('inline option-key / multi-key errors', () => {
	test('inline `margin` (an option key) is rejected — belongs in plugin config', () => {
		expectThrows(() => run(wrap(`import C from './C.svelte' with { hydrate: 'visible', margin: '9px' };`, '<C />')), /`margin` is not allowed inline/);
	});

	test('inline unknown key alongside a region key is rejected', () => {
		expectThrows(() => run(wrap(`import C from './C.svelte' with { hydrate: 'load', wat: 'x' };`, '<C />')), /`wat` is not allowed inline/);
	});

	test('error message names the file and the imported specifier list', () => {
		const msg = expectThrows(() => run(wrap(`import Foo from './Foo.svelte' with { hydrate: 'nope-strategy' };`, '<Foo />')), /unknown hydrate strategy/);
		expect(msg).toMatch(/src\/routes\/\+page\.svelte/);
		expect(msg).toMatch(/import \{ Foo \}/);
	});
});

describe('non-region imports are left alone', () => {
	test('a file with no region keys is not transformed (returns null)', () => {
		expect(run(wrap(`import x from './x.js';`, '<p>{x}</p>'))).toBe(null);
	});

	test('an import with only a standard `type` attribute is left alone even alongside an island', () => {
		const r = run(wrap(`${LOAD}\nimport data from './d.json' with { type: 'json' };`, '<C /><p>{data}</p>'));
		expect(r).toBeTruthy();
		expect(r!.code).toMatch(/import data from '\.\/d\.json' with \{ type: 'json' \};/);
	});

	test('a standard `type` import used INSIDE an island is copied into the island module', () => {
		const r = run(wrap(`${LOAD}\nimport data from './d.json' with { type: 'json' };`, '<C v={data} />'));
		expect(islandSource(r)).toMatch(/import data from '\.\/d\.json';/);
		expect(r!.code).toMatch(/import data from '\.\/d\.json' with \{ type: 'json' \};/);
	});
});

describe('deterministic ids + multi-island ordering + offset correctness', () => {
	test('island id is the stable md5(relHost::index) prefix', () => {
		const r = run(wrap(LOAD, '<C />'));
		expect(r!.islands[0].id).toBe(idFor(0));
		expect(r!.islands[0].id).toBe('22ee3a8bd72e');
	});

	test('ids are stable across repeated transforms (idempotent id generation)', () => {
		const a = run(wrap(LOAD, '<C />'))!.islands[0].id;
		const b = run(wrap(LOAD, '<C />'))!.islands[0].id;
		expect(a).toBe(b);
	});

	test('two distinct islands get index-0 and index-1 ids, in source order', () => {
		const r = run(wrap(`import A from './A.svelte' with { hydrate: 'load' };\nimport B from './B.svelte' with { hydrate: 'idle' };`, '<A /><B />'));
		expect(r!.islands[0].id).toBe(idFor(0));
		expect(r!.islands[1].id).toBe(idFor(1));
		const iA = r!.code.indexOf(idFor(0));
		const iB = r!.code.indexOf(idFor(1));
		expect(iA >= 0 && iB >= 0 && iA < iB, 'island 0 must appear before island 1').toBe(true);
	});

	test('multi-island: exact full host output (offset correctness with surrounding static markup)', () => {
		const src = wrap(
			`import A from './A.svelte' with { hydrate: 'load' };\nimport B from './B.svelte' with { hydrate: 'idle' };`,
			'<h1>title</h1>\n<A x={1} />\n<p>between</p>\n<B y={2} />\n<footer>end</footer>'
		);
		const r = run(src);
		const expected =
			`<script>\n` +
			`\timport { Island as OgygiaIsland__Wrapper } from 'ogygia/internal';\n` +
			`\timport __OgygiaIsland_0 from "/app/src/routes/.ogygia/${idFor(0)}.svelte";\n` +
			`\timport __OgygiaIsland_1 from "/app/src/routes/.ogygia/${idFor(1)}.svelte";\n` +
			`\n\n</script>\n` +
			`<h1>title</h1>\n` +
			`<OgygiaIsland__Wrapper load __entry={"${idFor(0)}"} __component={__OgygiaIsland_0} __props={{}} />\n` +
			`<p>between</p>\n` +
			`<OgygiaIsland__Wrapper idle __entry={"${idFor(1)}"} __component={__OgygiaIsland_1} __props={{}} />\n` +
			`<footer>end</footer>`;
		expect(r!.code).toBe(expected);
	});

	test('the same component used twice with different attrs -> two islands, distinct ids/modules', () => {
		const r = run(wrap(`import A from './A.svelte' with { hydrate: 'load' };`, '<A x={1} /><A x={2} />'));
		expect(r!.islands.length).toBe(2);
		expect(r!.islands[0].id).not.toBe(r!.islands[1].id);
		expect(r!.islands[0].source).toMatch(/<A x=\{1\}/);
		expect(r!.islands[1].source).toMatch(/<A x=\{2\}/);
	});

	test('an unused island import is stripped from the host and emits NO island', () => {
		const r = run(wrap(LOAD, '<p>no usage of C</p>'));
		expect(r, 'still returns a result (the import was stripped)').toBeTruthy();
		expect(r!.islands.length).toBe(0);
		expect(r!.code).not.toMatch(/import C from/);
		expect(r!.code).not.toMatch(/with \{ hydrate/);
	});
});

describe('usage inside control blocks', () => {
	const cases: Array<[string, string, string]> = [
		['{#if}', '{#if show}<C />{/if}', 'let show = true;'],
		['{#each}', '{#each list as item}<C {item} />{/each}', 'let list = [1];'],
		['{#key}', '{#key k}<C />{/key}', 'let k = 1;'],
		['{#await then}', '{#await promise then val}<C {val} />{/await}', 'let promise = Promise.resolve(1);'],
		['snippet body', '{#snippet body()}<C />{/snippet}{@render body()}', '']
	];
	for (const [label, markup, extra] of cases) {
		test(`island used inside ${label} is discovered`, () => {
			const r = run(wrap(`${LOAD}${extra ? '\n' + extra : ''}`, markup));
			expect(r, `expected transform for ${label}`).toBeTruthy();
			expect(r!.islands.length).toBe(1);
			expect(r!.code).toMatch(/OgygiaIsland__Wrapper/);
		});
	}
});

describe('captures', () => {
	test('let + const host vars become $props destructuring, in reference order', () => {
		const r = run(wrap(`${LOAD}\nlet count = 0;\nconst name = 'x';`, '<C {count} {name} />'));
		expect(propsObject(r!.code)).toBe('__props={{ count, name }}');
		expect(islandSource(r)).toMatch(/let \{ count, name \} = \$props\(\);/);
	});

	test('$state / $derived host runes are captured by name', () => {
		const r = run(wrap(`${LOAD}\nlet n = $state(0);\nlet d = $derived(n * 2);`, '<C {n} {d} />'));
		expect(propsObject(r!.code)).toBe('__props={{ n, d }}');
	});

	test('a module-script export is captured', () => {
		const src = `<script module>\nexport const K = 5;\n</script>\n<script>\n${LOAD}\n</script>\n<C v={K} />`;
		const r = run(src);
		expect(propsObject(r!.code)).toBe('__props={{ K }}');
		expect(islandSource(r)).toMatch(/let \{ K \} = \$props\(\);/);
	});

	test('{#each} item + index locals are NOT captured; an outer ref IS', () => {
		const r = run(wrap(`${LOAD}\nlet items = [1, 2];\nlet outer = 9;`, '<C>{#each items as item, i}<b>{item}{i}{outer}</b>{/each}</C>'));
		expect(propsObject(r!.code)).toBe('__props={{ items, outer }}');
	});

	test('{#await then value} local is NOT captured; an outer ref IS', () => {
		const r = run(wrap(`${LOAD}\nlet p = Promise.resolve(1);\nlet ext = 2;`, '<C>{#await p then val}{val}{ext}{/await}</C>'));
		expect(propsObject(r!.code)).toBe('__props={{ p, ext }}');
	});

	test('{@const} binding is NOT captured; its dependency IS', () => {
		const r = run(wrap(`${LOAD}\nlet base = 3;`, '<C>{@const doubled = base * 2}{doubled}{base}</C>'));
		expect(propsObject(r!.code)).toBe('__props={{ base }}');
	});

	test('a snippet param SHADOWS a host var of the same name (host var not captured)', () => {
		const r = run(wrap(`${LOAD}\nlet row = 'HOST';`, '<C>{#snippet r(row)}{row}{/snippet}{@render r(1)}</C>'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});

	test('globals in the allowlist (Math, JSON, Date) are not captured', () => {
		const r = run(wrap(LOAD, '<C a={Math.PI} b={JSON.stringify(1)} c={new Date()} />'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});

	test('a LOCALLY-shadowed global IS captured (host redefined `Date`)', () => {
		const r = run(wrap(`${LOAD}\nconst Date = 'shadow';`, '<C v={Date} />'));
		expect(propsObject(r!.code)).toBe('__props={{ Date }}');
	});

	test('$-prefixed identifier is captured verbatim', () => {
		const r = run(wrap(`${LOAD}\nlet $store = 1;`, '<C v={$store} />'));
		expect(propsObject(r!.code)).toBe('__props={{ $store }}');
	});

	test('a unicode identifier is captured verbatim', () => {
		const r = run(wrap(`${LOAD}\nlet café = 1;`, '<C v={café} />'));
		expect(propsObject(r!.code)).toBe('__props={{ café }}');
	});

	test('a var referenced only inside an inner arrow function is still captured', () => {
		const r = run(wrap(`${LOAD}\nlet total = 10;`, '<C fmt={() => total + 1} />'));
		expect(propsObject(r!.code)).toBe('__props={{ total }}');
	});

	test('a var declared INSIDE an inner function is NOT captured', () => {
		const r = run(wrap(LOAD, '<C fmt={() => { const local = 1; return local; }} />'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});

	test('no captures -> empty props object', () => {
		const r = run(wrap(LOAD, '<C />'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});
});

describe('imports copied into the island module', () => {
	test('a referenced relative import is copied', () => {
		const r = run(wrap(`${LOAD}\nimport { v } from './v.js';`, '<C x={v} />'));
		expect(islandSource(r)).toMatch(/import \{ v \} from '\.\/v\.js';/);
	});

	test('an UNREFERENCED extra import is NOT copied', () => {
		const r = run(wrap(`${LOAD}\nimport { unused } from './u.js';`, '<C />'));
		expect(islandSource(r)).not.toMatch(/unused/);
	});

	test('aliased named import is copied when the alias is referenced', () => {
		const r = run(wrap(`${LOAD}\nimport { foo as f } from './util.js';`, '<C a={f} />'));
		expect(islandSource(r)).toMatch(/import \{ foo as f \} from '\.\/util\.js';/);
	});

	test('namespace import is copied when a member is referenced', () => {
		const r = run(wrap(`${LOAD}\nimport * as NS from './ns.js';`, '<C a={NS.x} />'));
		expect(islandSource(r)).toMatch(/import \* as NS from '\.\/ns\.js';/);
	});

	test('a $lib import is copied verbatim', () => {
		const r = run(wrap(`${LOAD}\nimport U from '$lib/U.js';`, '<C x={U} />'));
		expect(islandSource(r)).toMatch(/import U from '\$lib\/U\.js';/);
	});

	test('an npm (bare) import is copied verbatim', () => {
		const r = run(wrap(`${LOAD}\nimport { z } from 'zod';`, '<C x={z} />'));
		expect(islandSource(r)).toMatch(/import \{ z \} from 'zod';/);
	});

	test('a type-only import is NOT copied when unreferenced in markup', () => {
		const r = run(wrapTs(`${LOAD}\nimport type { T } from './t.js';\nimport { v } from './v.js';`, '<C x={v} />'));
		expect(islandSource(r)).not.toMatch(/import type/);
		expect(islandSource(r)).toMatch(/import \{ v \} from '\.\/v\.js';/);
	});
});

describe('snippets', () => {
	test('a snippet defined INSIDE the island (children) is fine', () => {
		const r = run(wrap(LOAD, '<C>{#snippet item(x)}<b>{x}</b>{/snippet}</C>'));
		expect(r).toBeTruthy();
		expect(r!.islands.length).toBe(1);
	});

	test('nested snippets inside the island are fine', () => {
		const r = run(wrap(LOAD, '<C>{#snippet outer()}{#snippet inner()}x{/snippet}{@render inner()}{/snippet}{@render outer()}</C>'));
		expect(r).toBeTruthy();
		expect(r!.islands.length).toBe(1);
	});

	test('a HOST snippet referenced inside the island is a clear cross-boundary error', () => {
		const msg = expectThrows(() => run(wrap(LOAD, '{#snippet foo()}x{/snippet}<C>{@render foo()}</C>')), /references snippet `foo` defined outside the island/);
		expect(msg).toMatch(/Snippets cannot cross the island boundary/);
	});

	test('a host FUNCTION referenced inside the island is captured (serialization fails at runtime)', () => {
		const r = run(wrap(`${LOAD}\nfunction fmt(x) { return x; }`, '<C f={fmt} />'));
		expect(propsObject(r!.code)).toBe('__props={{ fmt }}');
	});
});

describe('remote imports', () => {
	test('a `.remote` import used inside the island is copied (import), never captured', () => {
		const r = run(wrap(`${LOAD}\nimport { createPost } from '$lib/posts.remote.js';`, '<C v={createPost} />'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
		expect(islandSource(r)).toMatch(/import \{ createPost \} from '\$lib\/posts\.remote\.js';/);
	});

	test('`{...createPost}` spread markup is preserved and the import copied', () => {
		const r = run(wrap(`${LOAD}\nimport { createPost } from '$lib/posts.remote.js';`, '<C {...createPost} />'));
		expect(islandSource(r)).toMatch(/<C \{\.\.\.createPost\} \/>/);
		expect(islandSource(r)).toMatch(/import \{ createPost \}/);
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});

	test('deep member chains (.fields.title.as(), .pending, .result) are preserved verbatim', () => {
		const r = run(wrap(`${LOAD}\nimport { createPost } from '$lib/posts.remote.js';`, '<C a={createPost.pending} b={createPost.result} c={createPost.fields.title.as("text")} />'));
		expect(islandSource(r)).toMatch(/createPost\.pending/);
		expect(islandSource(r)).toMatch(/createPost\.result/);
		expect(islandSource(r)).toMatch(/createPost\.fields\.title\.as\("text"\)/);
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});

	test('a query.live member chain is preserved', () => {
		const r = run(wrap(`${LOAD}\nimport { clock } from '$lib/time.remote.js';`, '<C v={clock().current} />'));
		expect(islandSource(r)).toMatch(/clock\(\)\.current/);
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});
});

describe('captured-var mutation guards', () => {
	const cases: Array<[string, string, string]> = [
		['assignment', '<C onclick={() => count = 1} />', 'let count = 0;'],
		['update ++', '<C onclick={() => count++} />', 'let count = 0;'],
		['compound +=', '<C onclick={() => count += 2} />', 'let count = 0;'],
		['member write', '<C onclick={() => obj.a = 9} />', 'let obj = { a: 1 };'],
		['array destructuring-assignment', '<C onclick={() => ([count, obj] = [1, {}])} />', 'let count = 0, obj = {};'],
		['bind:', '<C><input bind:value={count} /></C>', 'let count = 0;']
	];
	for (const [label, markup, decl] of cases) {
		test(`${label} of a captured var is a build error`, () => {
			expectThrows(() => run(wrap(`${LOAD}\n${decl}`, markup)), /mutates captured host variable/);
		});
	}

	test('error names the variable + the file + the fix', () => {
		const msg = expectThrows(() => run(wrap(`${LOAD}\nlet count = 0;`, '<C onclick={() => count++} />')), /mutates captured host variable `count`/);
		expect(msg).toMatch(/src\/routes\/\+page\.svelte/);
		expect(msg).toMatch(/serialized snapshot/);
		expect(msg).toMatch(/move mutable state inside the island/i);
	});

	test('writing a global (location) is NOT flagged', () => {
		expect(run(wrap(LOAD, '<C onclick={() => location.reload()} />'))).toBeTruthy();
	});

	test('mutating a handler-local var is NOT flagged', () => {
		expect(run(wrap(LOAD, '<C onclick={() => { let x = 0; x += 1; }} />'))).toBeTruthy();
	});

	test('mutating an each-local is NOT flagged', () => {
		expect(run(wrap(`${LOAD}\nlet items = [1];`, '<C>{#each items as it}<button onclick={() => it++}>x</button>{/each}</C>'))).toBeTruthy();
	});
});

describe('TS in expressions + lang propagation', () => {
	test('`lang="ts"` propagates to the generated island module', () => {
		const r = run(wrapTs(`${LOAD}\nlet n: number = 1;`, '<C {n} />'));
		expect(islandSource(r)).toMatch(/^<script lang="ts">/);
	});

	test('module-script lang is used when there is no instance-script lang', () => {
		const src = `<script module lang="ts">\nexport const K: number = 5;\n</script>\n<script>\n${LOAD}\n</script>\n<C v={K} />`;
		const r = run(src);
		expect(islandSource(r)).toMatch(/^<script lang="ts">/);
	});

	test('`as` cast in an attribute survives into the island markup', () => {
		const r = run(wrapTs(`${LOAD}\nlet val: unknown = 1;`, '<C v={val as number} />'));
		expect(islandSource(r)).toMatch(/val as number/);
		expect(propsObject(r!.code)).toBe('__props={{ val }}');
	});

	test('non-null assertion + satisfies are preserved and captured by root', () => {
		const r = run(wrapTs(`${LOAD}\nlet maybe: number | null = 1;\nlet cfg = { a: 1 };`, '<C a={maybe!} b={cfg satisfies object} />'));
		expect(islandSource(r)).toMatch(/maybe!/);
		expect(islandSource(r)).toMatch(/cfg satisfies object/);
		expect(propsObject(r!.code)).toBe('__props={{ maybe, cfg }}');
	});

	test('a generic call is preserved verbatim', () => {
		const r = run(wrapTs(`${LOAD}\nlet raw = '1';`, '<C v={JSON.parse<number>(raw)} />'));
		expect(islandSource(r)).toMatch(/JSON\.parse<number>\(raw\)/);
		expect(propsObject(r!.code)).toBe('__props={{ raw }}');
	});
});

describe('robustness', () => {
	test('an HTML comment near the island is preserved', () => {
		const r = run(wrap(LOAD, '<!-- lead comment -->\n<C />'));
		expect(r!.code).toMatch(/<!-- lead comment -->/);
	});

	test('CRLF line endings are handled', () => {
		const r = run(`<script>\r\n${LOAD}\r\n</script>\r\n<C a={1} />`);
		expect(r).toBeTruthy();
		expect(r!.code).toMatch(/OgygiaIsland__Wrapper/);
		expect(islandSource(r)).toMatch(/<C a=\{1\} \/>/);
	});

	test('self-closing and open/close element forms both work', () => {
		const rSelf = run(wrap(LOAD, '<C />'));
		const rOpen = run(wrap(LOAD, '<C></C>'));
		expect(rSelf!.islands[0].source).toMatch(/<C \/>/);
		expect(rOpen!.islands[0].source).toMatch(/<C><\/C>/);
	});

	test('leading/trailing whitespace around the usage is preserved in the host', () => {
		const r = run(wrap(LOAD, '  <C />  '));
		expect(r!.code).toMatch(/  <OgygiaIsland__Wrapper load [^>]*\/>  $/);
	});

	test('idempotency: transforming already-transformed output does not double-wrap (returns null)', () => {
		const once = run(wrap(LOAD, '<C a={1} />'));
		const twice = run(once!.code);
		expect(twice).toBe(null);
	});

	test('idempotency: a generated island module is not itself re-transformed via markup', () => {
		const r = run(wrap(LOAD, '<C />'));
		const second = run(islandSource(r));
		expect(second).toBe(null);
	});
});

describe('exact generated-module source', () => {
	test('captures + copied import', () => {
		const r = run(wrap(`${LOAD}\nimport { fmt } from './fmt.js';\nlet count = 0;`, '<C {count} label={fmt(count)} />'));
		const expected =
			`<script>\n` +
			`\timport C from './C.svelte';\n` +
			`\timport { fmt } from './fmt.js';\n` +
			`\tlet { count } = $props();\n` +
			`</script>\n` +
			`<C {count} label={fmt(count)} />\n`;
		expect(r!.islands[0].source).toBe(expected);
	});

	test('no captures, no extra imports', () => {
		const r = run(wrap(LOAD, '<C />'));
		expect(r!.islands[0].source).toBe(`<script>\n\timport C from './C.svelte';\n</script>\n<C />\n`);
	});
});

describe('lakes (hydrate: none inside a hydrated island)', () => {
	const LAKE_SRC = wrap(
		`import Host from './Host.svelte' with { hydrate: 'load' };\nimport Lake from './Lake.svelte' with { hydrate: 'none' };`,
		'<Host><Lake /></Host>'
	);

	test('wraps the lake usage, records the lake local + a metadata-only region', () => {
		const r = run(LAKE_SRC);
		const island = r!.islands.find((i) => i.source)!;
		expect(island.source).toMatch(/<ogygia-region data-lake entry="[0-9a-f]+"><OgygiaLakeBoundary>/);
		expect(island.source).toMatch(/import \{ LakeBoundary as OgygiaLakeBoundary \} from 'ogygia\/internal';/);
		expect(island.lakes).toEqual(['Lake']);
		expect(r!.islands.some((i) => i.kind === 'lake')).toBe(true);
	});

	test('the lake region carries the deterministic lake id', () => {
		const r = run(LAKE_SRC);
		const lakeRegion = r!.islands.find((i) => i.kind === 'lake')!;
		expect(lakeRegion.id).toBe(lakeIdFor(0, 0));
		expect(r!.islands.find((i) => i.source)!.source).toMatch(new RegExp(`entry="${lakeIdFor(0, 0)}"`));
	});

	test('the host Lake import is stripped (hoisted only)', () => {
		const r = run(LAKE_SRC);
		expect(r!.code).not.toMatch(/import Lake from/);
	});
});

describe('result-shape invariants', () => {
	test('code + map + islands are always present on a transform', () => {
		const r = run(wrap(LOAD, '<C />'));
		expect(typeof r!.code).toBe('string');
		expect(r!.map).toBeTruthy();
		expect(Array.isArray(r!.islands)).toBe(true);
	});

	test('each hydrate island carries id, virtualPath, source, hostPath', () => {
		const r = run(wrap(LOAD, '<C />'));
		const isl = r!.islands[0];
		expect(typeof isl.id).toBe('string');
		expect(isl.virtualPath).toMatch(/\.ogygia\/[0-9a-f]{12}\.svelte$/);
		expect(isl.hostPath).toBe(HOST);
		expect(typeof isl.source).toBe('string');
	});

	test('the cheap bailout: a file mentioning none of hydrate/defer/preset is skipped', () => {
		expect(run('<div>plain</div>')).toBe(null);
		expect(run(wrap(`import X from './x.js';`, '<X />'))).toBe(null);
	});
});

// ===========================================================================
// EXTENDED MATRIX
// ===========================================================================

describe('exact wrapper output per strategy', () => {
	const cases: Array<[string, string, string]> = [
		['load', `import C from './C.svelte' with { hydrate: 'load' };`, 'load'],
		['idle', `import C from './C.svelte' with { hydrate: 'idle' };`, 'idle'],
		['visible', `import C from './C.svelte' with { hydrate: 'visible' };`, 'visible="0px"'],
		['media', `import C from './C.svelte' with { hydrate: '(max-width: 600px)' };`, 'media="(max-width: 600px)"']
	];
	for (const [label, imp, attr] of cases) {
		test(`${label} -> exact <OgygiaIsland__Wrapper ${attr} …>`, () => {
			const r = run(wrap(imp, '<C />'));
			const expected = `<OgygiaIsland__Wrapper ${attr} __entry={"${idFor(0)}"} __component={__OgygiaIsland_0} __props={{}} />`;
			expect(r!.code).toContain(expected);
		});
	}

	test('server island -> exact <OgygiaServerIsland__Wrapper …> with fallback body', () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'load' };`, '<G a={1}>{#snippet fallback()}x{/snippet}</G>'));
		const expected =
			`<OgygiaServerIsland__Wrapper __entry={"${idFor(0)}"} __component={__OgygiaIsland_0} __props={{}} __defer={"load"}>` +
			`{#snippet fallback()}x{/snippet}</OgygiaServerIsland__Wrapper>`;
		expect(r!.code).toContain(expected);
	});
});

describe('captures across HOST control blocks (island nested in a host block)', () => {
	test('an island inside a host {#each} captures the item + index locals', () => {
		const r = run(wrap(`${LOAD}\nlet items = [1];`, '{#each items as item, idx}<C {item} n={idx} />{/each}'));
		expect(propsObject(r!.code)).toBe('__props={{ item, idx }}');
	});

	test('an island inside a host {#each} with a destructured pattern captures the destructured names', () => {
		const r = run(wrap(`${LOAD}\nlet rows = [{ a: 1, b: 2 }];`, '{#each rows as { a, b }}<C {a} {b} />{/each}'));
		expect(propsObject(r!.code)).toBe('__props={{ a, b }}');
	});

	test('an island inside a host {#each} with an array pattern captures the elements', () => {
		const r = run(wrap(`${LOAD}\nlet pairs = [[1, 2]];`, '{#each pairs as [x, y]}<C {x} {y} />{/each}'));
		expect(propsObject(r!.code)).toBe('__props={{ x, y }}');
	});

	test('an island inside a host {#await then} captures the resolved value local', () => {
		const r = run(wrap(`${LOAD}\nlet p = Promise.resolve(1);`, '{#await p then val}<C {val} />{/await}'));
		expect(propsObject(r!.code)).toBe('__props={{ val }}');
	});

	test('an island inside a host {#await catch} captures the error local', () => {
		const r = run(wrap(`${LOAD}\nlet p = Promise.resolve(1);`, '{#await p catch e}<C err={e} />{/await}'));
		expect(propsObject(r!.code)).toBe('__props={{ e }}');
	});

	test('an island inside a host {#key} captures nothing from the key expression', () => {
		const r = run(wrap(`${LOAD}\nlet k = 1;`, '{#key k}<C />{/key}'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});

	test('an island inside a host {#if} does not capture the (outside-subtree) condition', () => {
		const r = run(wrap(`${LOAD}\nlet show = true;`, '{#if show}<C />{/if}'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});
});

describe('component-name references + special elements inside islands', () => {
	test('a nested plain component used inside the island copies its import (root of a dotted name)', () => {
		const r = run(wrap(`${LOAD}\nimport Menu from './Menu.svelte';`, '<C><Menu.Item x={1} /></C>'));
		expect(islandSource(r)).toMatch(/import Menu from '\.\/Menu\.svelte';/);
		expect(propsObject(r!.code)).toBe('__props={{}}');
	});

	test('a nested plain component used inside the island copies its import (simple name)', () => {
		const r = run(wrap(`${LOAD}\nimport Row from './Row.svelte';`, '<C><Row /></C>'));
		expect(islandSource(r)).toMatch(/import Row from '\.\/Row\.svelte';/);
	});

	test('<svelte:element this={tag}> inside the island captures the tag var', () => {
		const r = run(wrap(`${LOAD}\nlet tag = 'div';`, '<C><svelte:element this={tag}>x</svelte:element></C>'));
		expect(propsObject(r!.code)).toBe('__props={{ tag }}');
	});

	test('a `let:` directive binds a name that is not captured inside the island', () => {
		const r = run(wrap(`${LOAD}\nimport List from './List.svelte';`, '<C><List let:item>{item}</List></C>'));
		expect(propsObject(r!.code)).toBe('__props={{}}');
		expect(islandSource(r)).toMatch(/import List from '\.\/List\.svelte';/);
	});
});

describe('import forms', () => {
	test('a combined default + named import is copied when referenced', () => {
		const r = run(wrap(`${LOAD}\nimport D, { n } from './m.js';`, '<C a={D} b={n} />'));
		expect(islandSource(r)).toMatch(/import D, \{ n \} from '\.\/m\.js';/);
	});

	test('a default import used inside the island is copied', () => {
		const r = run(wrap(`${LOAD}\nimport helper from './helper.js';`, '<C v={helper()} />'));
		expect(islandSource(r)).toMatch(/import helper from '\.\/helper\.js';/);
	});

	test('two islands that both reference an import each copy it into their own module', () => {
		const r = run(wrap(
			`import A from './A.svelte' with { hydrate: 'load' };\nimport B from './B.svelte' with { hydrate: 'idle' };\nimport { shared } from './s.js';`,
			'<A x={shared} /><B y={shared} />'
		));
		const modules = r!.islands.filter((i) => i.source);
		expect(modules.length).toBe(2);
		for (const m of modules) expect(m.source).toMatch(/import \{ shared \} from '\.\/s\.js';/);
	});

	test('an import referenced by only ONE of two islands is copied into only that module', () => {
		const r = run(wrap(
			`import A from './A.svelte' with { hydrate: 'load' };\nimport B from './B.svelte' with { hydrate: 'idle' };\nimport { onlyA } from './a-only.js';`,
			'<A x={onlyA} /><B />'
		));
		const [modA, modB] = r!.islands.filter((i) => i.source);
		expect(modA.source).toMatch(/onlyA/);
		expect(modB.source).not.toMatch(/onlyA/);
	});
});

describe('server island extras', () => {
	test('a server island with no fallback still hoists + wraps', () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'load' };`, '<G />'));
		expect(r!.code).toMatch(/OgygiaServerIsland__Wrapper/);
		expect(r!.islands[0].server).toBe(true);
	});

	test('a server island captures host props (rendered by the endpoint)', () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'load' };\nlet u = 1;`, '<G user={u}>{#snippet fallback()}x{/snippet}</G>'));
		expect(propsObject(r!.code)).toBe('__props={{ u }}');
	});

	test('a server island via preset behaves identically to defer:true', () => {
		const ctx = makeCtx({ presets: { srv: { defer: 'load' } } });
		const r = run(wrap(`import G from './G.svelte' with { preset: 'srv' };`, '<G />'), ctx);
		expect(r!.islands[0].server).toBe(true);
		expect(r!.islands[0].kind).toBe('defer');
	});
});

describe('spread attributes + complex props', () => {
	test('a spread attribute captures the spread host var', () => {
		const r = run(wrap(`${LOAD}\nlet rest = { a: 1 };`, '<C {...rest} />'));
		expect(propsObject(r!.code)).toBe('__props={{ rest }}');
	});

	test('an object-literal prop captures only its free identifiers', () => {
		const r = run(wrap(`${LOAD}\nlet a = 1;\nlet b = 2;`, '<C data={{ a, b, k: 3 }} />'));
		expect(propsObject(r!.code)).toBe('__props={{ a, b }}');
	});

	test('a prop that calls a captured function captures both (callee before argument)', () => {
		const r = run(wrap(`${LOAD}\nlet base = 1;\nfunction fmt(x) { return x; }`, '<C v={fmt(base)} />'));
		expect(propsObject(r!.code)).toBe('__props={{ fmt, base }}');
	});

	test('a captured var referenced twice appears only once in the props object', () => {
		const r = run(wrap(`${LOAD}\nlet x = 1;`, '<C a={x} b={x} c={x + 1} />'));
		expect(propsObject(r!.code)).toBe('__props={{ x }}');
	});

	test('captures preserve first-reference order across attributes', () => {
		const r = run(wrap(`${LOAD}\nlet a = 1;\nlet b = 2;\nlet c = 3;`, '<C p={c} q={a} r={b} />'));
		expect(propsObject(r!.code)).toBe('__props={{ c, a, b }}');
	});
});

describe('more media queries', () => {
	for (const q of ['(orientation: portrait)', '(prefers-color-scheme: dark)', '(min-width: 640px) and (max-width: 1024px)', '(hover: hover)']) {
		test(`media query ${q} rides as the wrapper media attr`, () => {
			const r = run(wrap(`import C from './C.svelte' with { hydrate: '${q}' };`, '<C />'));
			expect(r!.code).toContain(`media=${JSON.stringify(q)}`);
		});
	}
});

describe('more preset tolerance', () => {
	test('a defer preset ignores an inapplicable margin key (tolerant)', () => {
		const ctx = makeCtx({ presets: { srvm: { defer: 'load', margin: '10px' } } });
		const r = run(wrap(`import G from './G.svelte' with { preset: 'srvm' };`, '<G />'), ctx);
		expect(r!.islands[0].server).toBe(true);
	});

	test('an idle preset ignores an inapplicable margin key (tolerant)', () => {
		const ctx = makeCtx({ presets: { idlem: { hydrate: 'idle', margin: '10px' } } });
		const r = run(wrap(`import C from './C.svelte' with { preset: 'idlem' };`, '<C />'), ctx);
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper idle __entry=/);
	});
});

describe('more mutation-guard cases', () => {
	test('a deep member write (obj.a.b = …) on a captured object is a build error', () => {
		expectThrows(() => run(wrap(`${LOAD}\nlet obj = { a: { b: 1 } };`, '<C onclick={() => obj.a.b = 2} />')), /mutates captured host variable `obj`/);
	});

	test('an update on a captured member (obj.n++) is a build error', () => {
		expectThrows(() => run(wrap(`${LOAD}\nlet obj = { n: 0 };`, '<C onclick={() => obj.n++} />')), /mutates captured host variable `obj`/);
	});

	test('a computed-member write (arr[i] = …) on a captured array is a build error', () => {
		expectThrows(() => run(wrap(`${LOAD}\nlet arr = [1];`, '<C onclick={() => arr[0] = 9} />')), /mutates captured host variable `arr`/);
	});

	test('object destructuring-assignment with a rest ({ ...rest } = …) flags the rest root', () => {
		expectThrows(() => run(wrap(`${LOAD}\nlet rest = {};`, '<C onclick={() => ({ ...rest } = { a: 1 })} />')), /mutates captured host variable `rest`/);
	});

	test('a compound bitwise assign (count &= 1) is flagged', () => {
		expectThrows(() => run(wrap(`${LOAD}\nlet count = 3;`, '<C onclick={() => count &= 1} />')), /mutates captured host variable `count`/);
	});

	test('reading a captured var inside a handler that only mutates a LOCAL is fine', () => {
		expect(run(wrap(`${LOAD}\nlet base = 1;`, '<C onclick={() => { let sum = base; sum += 1; }} />'))).toBeTruthy();
	});
});

describe('formatting robustness', () => {
	test('attributes spread across multiple lines are handled', () => {
		const r = run(wrap(`${LOAD}\nlet a = 1;\nlet b = 2;`, '<C\n\ta={a}\n\tb={b}\n/>'));
		expect(propsObject(r!.code)).toBe('__props={{ a, b }}');
		expect(r!.code).toMatch(/OgygiaIsland__Wrapper/);
	});

	test('an island with text children preserves the text in the island module', () => {
		const r = run(wrap(LOAD, '<C>hello <b>world</b></C>'));
		expect(islandSource(r)).toMatch(/<C>hello <b>world<\/b><\/C>/);
	});

	test('extra blank lines in the host script are tolerated', () => {
		const r = run(`<script>\n\n${LOAD}\n\nlet count = 0;\n\n</script>\n<C {count} />`);
		expect(propsObject(r!.code)).toBe('__props={{ count }}');
	});

	test('an island as the very first and very last node of the template', () => {
		const r = run(wrap(`import A from './A.svelte' with { hydrate: 'load' };\nimport B from './B.svelte' with { hydrate: 'idle' };`, '<A />middle<B />'));
		expect(r!.islands.filter((i) => i.source).length).toBe(2);
		expect(r!.code).toMatch(/\/>middle<OgygiaIsland__Wrapper idle/);
	});
});

describe('dev-mode context (shell-lake warning path)', () => {
	test('a shell lake under dev returns a result with the import cleaned (no throw)', () => {
		const r = run(wrap(`import L from './L.svelte' with { hydrate: 'none' };`, '<L />'), makeCtx({ dev: true }));
		expect(r).toBeTruthy();
		expect(r!.code).toMatch(/import L from '\.\/L\.svelte';/);
	});

	test('dev url is used for a hydrate island __entry when dev:true', () => {
		const r = run(wrap(LOAD, '<C />'), makeCtx({ dev: true }));
		// dev __entry is the devUrlFor(virtualPath), not the raw id
		expect(r!.code).toMatch(/__entry=\{"\/src\/routes\/\.ogygia\/[0-9a-f]{12}\.svelte"\}/);
	});
});

describe('member reads + exact server-island module', () => {
	test('reading a member of a captured object captures the object only', () => {
		const r = run(wrap(`${LOAD}\nlet user = { name: 'x' };`, '<C n={user.name} greet={user.name.toUpperCase()} />'));
		expect(propsObject(r!.code)).toBe('__props={{ user }}');
	});

	test('a computed member read captures both the object and the index var', () => {
		const r = run(wrap(`${LOAD}\nlet arr = [1];\nlet i = 0;`, '<C v={arr[i]} />'));
		expect(propsObject(r!.code)).toBe('__props={{ arr, i }}');
	});

	test('exact generated island module for a server island (no fallback, one capture)', () => {
		const r = run(wrap(`import G from './G.svelte' with { defer: 'load' };\nlet user = 1;`, '<G {user} />'));
		const expected = `<script>\n\timport G from './G.svelte';\n\tlet { user } = $props();\n</script>\n<G {user} />\n`;
		expect(r!.islands[0].source).toBe(expected);
	});
});

describe('multiple lakes in one island', () => {
	const SRC = wrap(
		`import Host from './Host.svelte' with { hydrate: 'load' };\nimport L1 from './L1.svelte' with { hydrate: 'none' };\nimport L2 from './L2.svelte' with { hydrate: 'none' };`,
		'<Host><L1 /><L2 /></Host>'
	);

	test('two lakes get lake ids 0 and 1 and both locals recorded', () => {
		const r = run(SRC);
		const island = r!.islands.find((i) => i.source)!;
		expect(island.lakes).toEqual(['L1', 'L2']);
		expect(island.source).toMatch(new RegExp(`entry="${lakeIdFor(0, 0)}"`));
		expect(island.source).toMatch(new RegExp(`entry="${lakeIdFor(0, 1)}"`));
	});

	test('two metadata-only lake regions are registered', () => {
		const r = run(SRC);
		expect(r!.islands.filter((i) => i.kind === 'lake').length).toBe(2);
	});

	test('both host lake imports are stripped', () => {
		const r = run(SRC);
		expect(r!.code).not.toMatch(/import L1 from/);
		expect(r!.code).not.toMatch(/import L2 from/);
	});
});

describe('preset visible margin resolution', () => {
	test('a visible preset with no margin key falls back to the global default margin', () => {
		const ctx = makeCtx({ visibleMargin: '333px', presets: { v: { hydrate: 'visible' } } });
		const r = run(wrap(`import C from './C.svelte' with { preset: 'v' };`, '<C />'), ctx);
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper visible="333px" __entry=/);
	});

	test('a visible preset margin overrides the global default', () => {
		const ctx = makeCtx({ visibleMargin: '10px', presets: { v: { hydrate: 'visible', margin: '400px' } } });
		const r = run(wrap(`import C from './C.svelte' with { preset: 'v' };`, '<C />'), ctx);
		expect(r!.code).toMatch(/<OgygiaIsland__Wrapper visible="400px" __entry=/);
	});
});
