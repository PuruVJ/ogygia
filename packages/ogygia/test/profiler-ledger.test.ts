import { describe, expect, it } from 'vitest';
import { sourcemap_resolver, type FrameStat } from '../src/profiler/analyze.js';
import { build_ledger, confirmed, grows_between, grows_of, short_source } from '../src/profiler/ledger.js';
import type { GcMaker } from '../src/profiler/gc.js';
import type { RetainedSite } from '../src/profiler/insights.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE LINE LEDGER: every cost the profiler measured, joined on the app line a person edits.
// ─────────────────────────────────────────────────────────────────────────────

const fn = (o: Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path'>): FrameStat =>
	({
		url: '',
		line: 1,
		col: 0,
		category: 'app',
		self_ms: 0,
		total_ms: 0,
		self_pct: 0,
		total_pct: 0,
		...o
	}) as FrameStat;

describe('line ledger', () => {
	it('joins CPU, allocations, GC and retained bytes on one app line, with its code', () => {
		const path = '/app/src/lib/ds-ssr.ts';
		const functions = [
			fn({
				key: 'render',
				name: 'render',
				path,
				category: 'app',
				lines: [
					{ line: 62, ms: 4 },
					{ line: 70, ms: 1 }
				]
			}),
			// a dependency's lines never land in the ledger: the reader cannot edit them
			fn({
				key: 'dep',
				name: 'dep',
				path: '/app/node_modules/x/index.js',
				category: 'dependency',
				lines: [{ line: 3, ms: 9 }]
			})
		];
		const makers = [
			{ name: 'replace', allocated: 2_000_000, gc_ms: 3, at: { path, line: 62 } }
		] as unknown as GcMaker[];
		const retained = [
			{ name: 'Map', bytes: 50_000, at: { path, line: 70 } }
		] as unknown as RetainedSite[];
		const ledger = build_ledger({
			functions,
			makers,
			retained,
			code: (p, l) => (p === path && l === 62 ? '\t\thtml = html.replace(re, fn);  ' : undefined)
		});
		expect(ledger.map((l) => l.line)).toEqual([62, 70]);
		const top = ledger[0];
		expect(top).toMatchObject({
			file: 'src/lib/ds-ssr.ts',
			cpu_ms: 4,
			alloc_bytes: 2_000_000,
			gc_ms: 3,
			retained_bytes: 0,
			fn: 'render',
			code: 'html = html.replace(re, fn);'
		});
		expect(top.who).toEqual(['render', 'replace']);
		expect(ledger[1]).toMatchObject({ cpu_ms: 1, retained_bytes: 50_000 });
		expect(ledger[1].code).toBeUndefined();
	});

	it('memory charged to a function’s first line joins that function’s hottest line', () => {
		const path = '/app/src/lib/ds-ssr.ts';
		const functions = [
			fn({
				key: 'splice',
				name: '(anonymous)',
				path,
				line: 61,
				lines: [
					{ line: 62, ms: 180 },
					{ line: 63, ms: 1 }
				]
			})
		];
		const makers = [
			{ name: 'replace', allocated: 1_800_000_000, gc_ms: 52, at: { path, line: 61 } }
		] as unknown as GcMaker[];
		const ledger = build_ledger({ functions, makers });
		expect(ledger[0]).toMatchObject({
			line: 62,
			cpu_ms: 180,
			alloc_bytes: 1_800_000_000,
			gc_ms: 52,
			mem_in_fn: true
		});
		expect(ledger.find((l) => l.line === 61)).toBeUndefined();
		expect(ledger.find((l) => l.line === 63)?.mem_in_fn).toBeUndefined();
	});

	it('ogygia’s own source through a workspace link is the library, not a line the app edits', () => {
		// a linked checkout has no node_modules segment: `packages/ogygia/src/…` still is not the app
		const own = '/repo/packages/ogygia/src/seed-refs.ts';
		const makers = [
			{ name: 'hash_subtree', allocated: 9_000_000, gc_ms: 1, at: { path: own, line: 119 } }
		] as unknown as GcMaker[];
		const retained = [
			{
				name: 'island_wire',
				bytes: 500_000,
				at: { path: '/repo/node_modules/ogygia/dist/Region.svelte', line: 414 }
			},
			{ name: 'hash_subtree', bytes: 500_000, at: { path: own, line: 119 } }
		] as unknown as RetainedSite[];
		expect(build_ledger({ functions: [], makers, retained })).toEqual([]);
	});

	it('merged calls split back: an inlined function’s time on the next line goes home, by the un-inlined render', () => {
		const path = '/app/src/routes/+page.server.ts';
		const src = [
			'',
			'export async function load() {',
			'\tconst valid = rows();',
			'\tconst joined = attachBrands(valid);',
			'\tconst hits = joined.filter((p) => matches(p, term));',
			'\treturn { hits };',
			'}'
		];
		const source = (_p: string, a: number, b: number) => ({
			start: a,
			lines: src.slice(a - 1, b).map((l) => l ?? '')
		});
		// the profile: attachBrands and matches were inlined into load; all 90 ms landed on line 5
		const functions = [
			fn({
				key: 'load ' + path,
				name: 'load',
				path,
				line: 2,
				total_ms: 95,
				lines: [{ line: 5, ms: 90 }]
			})
		];
		// inlining off: attachBrands 40 ms, matches 4 ms, load's own line 5 work 1 ms
		const uninlined = [
			{ name: 'load', path, category: 'app' as const, total_ms: 50, lines: [{ line: 5, ms: 1 }] },
			{
				name: 'attachBrands',
				path: '/app/src/lib/catalog.ts',
				category: 'app' as const,
				total_ms: 40
			},
			{ name: 'matches', path: '/app/src/lib/catalog.ts', category: 'app' as const, total_ms: 4 }
		];
		const ledger = build_ledger({ functions, source, uninlined, renders: 1 });
		const at = (l: number) => ledger.find((x) => x.line === l);
		// 90 × 40/45 goes to attachBrands' line; line 5 keeps its own work and matches' share
		expect(at(4)).toMatchObject({ cpu_ms: 80, merged: { from: 5, callee: 'attachBrands' } });
		expect(at(5)?.cpu_ms).toBe(10);
		// a callee that kept its frame keeps its time: nothing moves
		const framed = [
			...functions,
			fn({
				key: 'attachBrands',
				name: 'attachBrands',
				path: '/app/src/lib/catalog.ts',
				total_ms: 120,
				lines: [{ line: 9, ms: 120 }]
			})
		];
		const kept = build_ledger({ functions: framed, source, uninlined, renders: 3 });
		expect(kept.find((x) => x.line === 5)?.cpu_ms).toBe(90);
		expect(kept.some((x) => x.merged)).toBe(false);
	});

	it('skips makers with no app line and caps the list', () => {
		const makers = [
			{ name: 'a', allocated: 10, gc_ms: 0 },
			{ name: 'b', allocated: 10, gc_ms: 0, at: { path: 'node:internal/x', line: 1 } }
		] as unknown as GcMaker[];
		expect(build_ledger({ functions: [], makers })).toEqual([]);
		const many = Array.from({ length: 60 }, (_, i) =>
			fn({ key: 'f' + i, name: 'f' + i, path: '/a/src/x.ts', lines: [{ line: i + 1, ms: i + 1 }] })
		);
		const out = build_ledger({ functions: many, limit: 5 });
		expect(out).toHaveLength(5);
		expect(out[0].line).toBe(60);
	});

	it('library time lands on the app line that calls it, through an import alias, split over repeat calls', () => {
		const path = '/app/src/lib/ds-ssr.ts';
		const src = [
			"import { renderToString as render } from '@lib/core/hydrate';", // 1
			'', // 2
			'export async function run(tags) {', // 3
			'\treturn Promise.all(', // 4
			'\t\ttags.map(async (tag) => {', // 5
			'\t\t\tlet el = await render(tag, { full: false }); // not render(x) in a comment', // 6
			'\t\t\tel = fix(el);', // 7
			'\t\t\treturn await render(el, {});', // 8
			'\t\t})', // 9
			'\t);', // 10
			'}', // 11
			'function after() { render(1); }' // 12: outside the function, never charged
		];
		const source = (p: string, a: number, b: number) =>
			p === path ? { start: a, lines: src.slice(a - 1, b) } : undefined;
		const functions = [
			fn({
				key: 'anon',
				name: '(anonymous)',
				path,
				line: 5,
				callees: [
					{
						key: 'rts',
						name: 'renderToString',
						category: 'dependency',
						file: '@lib/core/hydrate/index.mjs:40',
						ms: 300,
						share: 0.9
					},
					{
						key: 'fix',
						name: 'fix',
						category: 'app',
						file: 'src/lib/fix.ts:1',
						ms: 5,
						share: 0.02
					},
					{
						key: 'n',
						name: 'callback',
						category: 'dependency',
						file: 'x/y.js:1',
						ms: 9,
						share: 0.03
					}
				]
			})
		];
		const ledger = build_ledger({ functions, source, code: (p, l) => source(p, l, l)?.lines[0] });
		expect(ledger.map((l) => l.line).sort()).toEqual([6, 8]);
		expect(ledger[0]).toMatchObject({
			lib_ms: 150,
			fn: 'anon',
			libs: [{ name: 'renderToString', pkg: '@lib/core', ms: 150, shared: 2 }]
		});
	});

	it('the framework’s own calls (Kit’s json / resolve) are never library time on a line', () => {
		const path = '/app/src/routes/api/+server.ts';
		const src = ['export function GET() {', '\treturn json({ ok: true });', '}'];
		const source = (p: string, a: number, b: number) =>
			p === path ? { start: a, lines: src.slice(a - 1, b) } : undefined;
		const functions = [
			fn({
				key: 'GET',
				name: 'GET',
				path,
				line: 1,
				callees: [
					{
						key: 'json',
						name: 'json',
						category: 'dependency',
						file: '@sveltejs/kit/src/exports/index.js:40',
						ms: 5,
						share: 0.9
					}
				]
			}),
			fn({
				key: 'json',
				name: 'json',
				path: '/app/node_modules/@sveltejs/kit/src/exports/index.js',
				line: 40,
				category: 'dependency',
				pkg: '@sveltejs/kit'
			})
		];
		expect(build_ledger({ functions, source }).filter((l) => l.lib_ms > 0)).toEqual([]);
	});

	it('memory a library made after an await (no app caller) goes to the app line that calls that library', () => {
		const path = '/app/src/lib/ds.ts';
		const src = [
			"import { renderToString } from '@acme/core';",
			'export const render = (html) => renderToString(html);'
		];
		const source = (p: string, a: number, b: number) =>
			p === path ? { start: a, lines: src.slice(a - 1, b) } : undefined;
		const functions = [
			fn({
				key: 'render',
				name: 'render',
				path,
				line: 2,
				callees: [
					{
						key: 'rts',
						name: 'renderToString',
						category: 'dependency',
						file: '@acme/core/hydrate/index.mjs:40',
						ms: 300,
						share: 1
					}
				]
			}),
			fn({
				key: 'rts',
				name: 'renderToString',
				path: '/app/node_modules/.pnpm/@acme+core@1/node_modules/@acme/core/hydrate/index.mjs',
				line: 40,
				category: 'dependency',
				pkg: '@acme/core'
			})
		];
		const retained = [
			{
				name: 'hydrateAppClosure',
				url: '/app/node_modules/.pnpm/@acme+core@1/node_modules/@acme/core/hydrate/index.mjs',
				line: 171,
				bytes: 54e6
			}
		] as unknown as RetainedSite[];
		const makers = [
			{
				name: 'parse',
				url: '/app/node_modules/.pnpm/@acme+core@1/node_modules/@acme/core/hydrate/index.mjs',
				line: 9,
				allocated: 8e6,
				gc_ms: 2
			}
		] as unknown as GcMaker[];
		const [top] = build_ledger({ functions, source, retained, makers });
		expect(top).toMatchObject({
			line: 2,
			retained_bytes: 54e6,
			alloc_bytes: 8e6,
			gc_ms: 2,
			mem_via: '@acme/core'
		});
	});

	it('short paths', () => {
		expect(short_source('file:///srv/app/src/routes/+page.svelte')).toBe('src/routes/+page.svelte');
		expect(short_source('/srv/node_modules/svelte/src/index.js')).toBe('svelte/src/index.js');
		expect(short_source('/a/b/c/d/e.js')).toBe('c/d/e.js');
	});

	it('the resolver reads a source from the map’s embedded copy when the file is not on this machine', () => {
		const map = JSON.stringify({
			version: 3,
			sources: ['../src/lib/fmt.ts'],
			sourcesContent: ['const a = 1;\nexport const b = a + 1;\n'],
			names: [],
			mappings: 'AAAA'
		});
		const r = sourcemap_resolver((p) => (p === '/build/out.js.map' ? map : undefined));
		const at = r.resolve('/build/out.js', 0, 0);
		expect(at).toBeDefined();
		expect(r.source_lines(at!.source, 1, 2)).toEqual({
			start: 1,
			lines: ['const a = 1;', 'export const b = a + 1;']
		});
		expect(r.line_at_source(at!.source, 2)).toBe('export const b = a + 1;');
		expect(r.source_lines('/nowhere.ts', 1, 1)).toBeUndefined();
	});

	it('a map with no mappings (a plugin broke the chain) still resolves by the line’s own text, inside its region', () => {
		const source = [
			"import { query } from '$app/server';",
			'',
			'export const stock = query(async () => {',
			"\tconst res = await fetch('/api/stock');",
			'\tconst j = (await res.json()) as { n: number };',
			"\tawait log('done');",
			'\treturn j.n;',
			'});'
		].join('\n');
		const out = [
			'import { n as query } from "./remote.js";',
			'//#region src/lib/stock.remote.ts',
			'var stock = query(async () => {',
			'\tconst j = await (await fetch("/api/stock")).json();',
			'\tawait log("done");',
			'\treturn j.n;',
			'});',
			'init_remote_functions(exports, "src/lib/stock.remote.ts");',
			'//#endregion'
		].join('\n');
		const map = JSON.stringify({
			version: 3,
			sources: ['../../src/lib/stock.remote.ts'],
			sourcesContent: [source],
			names: [],
			mappings: ''
		});
		const r = sourcemap_resolver((p) =>
			p === '/b/chunks/stock.remote.js.map'
				? map
				: p === '/b/chunks/stock.remote.js'
					? out
					: undefined
		);
		const at = (l: number) => r.resolve('/b/chunks/stock.remote.js', l - 1, 0)?.line;
		// quotes reprinted, a joined line takes the line below its matched neighbour
		expect([at(3), at(4), at(5), at(6)]).toEqual([3, 4, 6, 7]);
		// outside the region (the chunk's imports) and the code a plugin appended: no guess
		expect(at(1)).toBeUndefined();
		expect(at(8)).toBeUndefined();
	});

	it("a library entry V8 inlined away: the inlining-off render says which app line entered the package", () => {
		const page = '/app/src/routes/+page.server.ts';
		const cat = '/app/src/lib/catalog.ts';
		const files: Record<string, string[]> = {
			[page]: ['export async function load() {', '\tconst ok = validateAll(rows);', '\treturn { ok };', '}'],
			[cat]: [
				"import * as v from 'valibot';",
				'export function validateAll(rows) {',
				'\treturn rows.filter((r) => v.safeParse(S, r).success);',
				'}'
			]
		};
		const source = (p: string, a: number, b: number) =>
			files[p] ? { start: a, lines: files[p].slice(a - 1, b) } : undefined;
		// the timed renders: validateAll and safeParse inlined into load; valibot's inner `~run` is
		// load's callee, a name no line spells
		const functions = [
			fn({
				key: 'load',
				name: 'load',
				path: page,
				line: 1,
				lines: [{ line: 2, ms: 2 }],
				callees: [{ key: 'run', name: '~run', category: 'dependency', pkg: 'valibot', file: 'valibot/dist/index.mjs:1', ms: 20, share: 0.9 }]
			})
		];
		// inlining off: load → validateAll → (anonymous) → safeParse
		const uninlined = [
			fn({
				key: 'u-load',
				name: 'load',
				path: page,
				line: 1,
				total_ms: 40,
				callees: [{ key: 'u-va', name: 'validateAll', category: 'app', file: 'src/lib/catalog.ts:2', ms: 39, share: 0.97 }]
			}),
			fn({
				key: 'u-va',
				name: 'validateAll',
				path: cat,
				line: 2,
				total_ms: 39,
				callees: [{ key: 'u-sp', name: 'safeParse', category: 'dependency', pkg: 'valibot', file: 'valibot/dist/index.mjs:9', ms: 38, share: 0.97 }]
			})
		];
		const ledger = build_ledger({ functions, uninlined, source, code: (p, l) => source(p, l, l)?.lines[0] });
		const row = ledger.find((l) => l.path === cat && l.line === 3)!;
		expect(row).toMatchObject({ lib_ms: 20, libs: [{ name: '~run', pkg: 'valibot', ms: 20 }] });
		// without that render: load's one calling line (the call that led there), not a guess among many
		const blind = build_ledger({ functions, source, code: (p, l) => source(p, l, l)?.lines[0] });
		expect(blind.filter((l) => l.lib_ms > 0).map((l) => [l.path, l.line])).toEqual([[page, 2]]);
		files[page] = ['export async function load() {', '\tconst ok = validateAll(rows);', '\treturn { ok: log(ok) };', '}'];
		const two = build_ledger({ functions, source, code: (p, l) => source(p, l, l)?.lines[0] });
		expect(two.some((l) => l.lib_ms > 0)).toBe(false);
	});
});

describe('per-line growth', () => {
	it('a line holding about N renders’ worth after N renders grows; one holding about one render’s is flat', () => {
		const path = '/app/src/lib/cache.ts';
		const at = (line: number) => ({ path, line });
		const retained = [
			{ name: 'set', url: path, line: 2, bytes: 1e6, at: at(2) },
			{ name: 'push', url: path, line: 5, bytes: 1e6, at: at(5) }
		] as unknown as RetainedSite[];
		const grown = {
			renders: 6,
			sites: [
				{ name: 'set', url: path, line: 2, bytes: 5.8e6, at: at(2) },
				{ name: 'push', url: path, line: 5, bytes: 1.1e6, at: at(5) }
			] as unknown as RetainedSite[]
		};
		const ledger = build_ledger({ functions: [], retained, grown });
		expect(ledger.find((l) => l.line === 2)?.grows).toBe(true);
		expect(ledger.find((l) => l.line === 5)?.grows).toBe(false);
		expect(
			build_ledger({ functions: [], retained }).find((l) => l.line === 2)?.grows
		).toBeUndefined();
	});
});

describe('grows_between', () => {
	it('halfway against the end of one sampler: a leak doubles over 3→6, a 4-entry cache does not', () => {
		expect(grows_between(3e6, 6.1e6, 3, 6)).toBe(true);
		expect(grows_between(3.4e6, 4.6e6, 3, 6)).toBe(false); // 3 entries → 4 (the cache filled)
		expect(grows_between(3e6, 3e6, 3, 6)).toBe(false);
		// the halfway read sampled none of the line: no evidence either way (never "grows")
		expect(grows_between(0, 4.6e6, 3, 6)).toBeUndefined();
		// a 4-entry cache sampled low halfway and high at the end reads as growth; the one-render
		// amount says it holds 4 renders' worth of 6: no verdict. A leak holds all 6: grows
		expect(grows_between(2e6, 4.2e6, 3, 6)).toBe(true);
		expect(confirmed(grows_between(2e6, 4.2e6, 3, 6), 4.2e6, 1.05e6, 6)).toBeUndefined();
		expect(confirmed(true, 6.1e6, 1e6, 6)).toBe(true);
		expect(confirmed(false, 1e6, 1e6, 6)).toBe(false);
		expect(grows_between(3e6, 4.9e6, 3, 6)).toBeUndefined(); // the middle band
		expect(grows_between(3e6, 6e6, 2, 4)).toBeUndefined(); // too few renders
	});

	it('a check cut to 5 renders never calls a 4-entry cache a leak (the slow-patterns flake)', () => {
		// a 4-entry cache over 5 renders: 3 halfway, 4 at the end, and a low draw halfway
		const e = 0.9e6;
		expect(grows_between(2.4 * e, 4 * e, 3, 5)).toBeUndefined();
		expect(grows_between(3 * e, 5 * e, 3, 5)).toBeUndefined(); // even a real leak: too few renders to say
		expect(grows_of(4 * e, e, 5)).toBeUndefined(); // 4 of 5 renders' worth
		expect(grows_of(1.5 * e, e, 5)).toBe(false); // flat still reads from 5
		expect(grows_of(6 * e, e, 6)).toBe(true);
	});

	it('confirming takes the larger per-render estimate: a low one-render draw cannot make a cache a leak', () => {
		const e = 0.9e6;
		// 6 renders, a 4-entry cache; the one-render pass drew low (0.7 e), the halfway read did not
		expect(confirmed(true, 4 * e, 0.7 * e, 6)).toBe(true); // the old reading: 4/(0.7×6) = 0.95
		expect(confirmed(true, 4 * e, 0.7 * e, 6, { bytes: 3 * e, renders: 3 })).toBeUndefined();
		// a leak holds every render's worth whichever estimate is used
		expect(confirmed(true, 6 * e, 0.7 * e, 6, { bytes: 3 * e, renders: 3 })).toBe(true);
	});
});
