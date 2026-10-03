import { describe, expect, it } from 'vitest';
import { fix_check_of, line_deltas, pattern_deltas, still_there } from '../src/profiler/compare.js';
import { link_patterns } from '../src/profiler/report.js';
import type { Pattern } from '../src/profiler/patterns.js';
import type { FrameStat } from '../src/profiler/analyze.js';
import type { LedgerLine } from '../src/profiler/ledger.js';
import {
	cache_rules,
	counted_sync_io,
	find_cold_caches,
	find_patterns,
	find_same_answers,
	find_wait_patterns,
	fix_impact,
	heap_growth,
	is_flat,
	in_loop,
	same_document_pattern,
	seed_whole_pattern,
	stable_answers,
	tokens,
	wait_save_on_path,
	type WaitCall
} from '../src/profiler/patterns.js';

// ─────────────────────────────────────────────────────────────────────────────
// PATTERNS: known slow shapes, recognised on the costly lines and backed by what was measured.
// ─────────────────────────────────────────────────────────────────────────────

const fn = (o: Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path' | 'line'>): FrameStat =>
	({ url: '', col: 0, category: 'app', self_ms: 0, total_ms: 0, ...o }) as FrameStat;
const row = (o: Partial<LedgerLine> & Pick<LedgerLine, 'path' | 'line' | 'code'>): LedgerLine => ({
	file: o.path.split('/').slice(-2).join('/'),
	cpu_ms: 0,
	alloc_bytes: 0,
	gc_ms: 0,
	retained_bytes: 0,
	lib_ms: 0,
	who: [],
	score: 1,
	...o
});
/** a source reader over an in-memory file */
const src_of = (files: Record<string, string>) => (p: string, a: number, b: number) => {
	const all = files[p]?.split('\n');
	if (!all) return undefined;
	return { start: a, lines: all.slice(a - 1, b) };
};

describe('tokens', () => {
	it('keeps identifiers and punctuation, drops strings, numbers and comments', () => {
		expect(tokens(`html = html.replace(tag, "a.replace(") // .sort(`)).toEqual([
			'html',
			'=',
			'html',
			'.',
			'replace',
			'(',
			'tag',
			',',
			'""',
			')'
		]);
		expect(tokens('x += [...acc, 12.5] /* no */ => a?.b')).toEqual([
			'x',
			'+=',
			'[',
			'...',
			'acc',
			',',
			'0',
			']',
			'=>',
			'a',
			'?.',
			'b'
		]);
		expect(tokens("'it\\'s'.split(' ')")).toEqual(['""', '.', 'split', '(', '""', ')']);
	});
});

describe('in_loop', () => {
	it('sees for / while / callback bodies, a same-line loop header, and {#each}', () => {
		expect(in_loop(['function f(xs) {', '  for (const x of xs) {', '    use(x);'])).toBe(true);
		expect(
			in_loop(['function f(xs) {', '  for (let i = 0; i < n; i++) {', '  }', '  done();'])
		).toBe(false);
		expect(
			in_loop(['() => {', '  for (const { tag, el } of rendered) html = html.replace(tag, el);'])
		).toBe(true);
		expect(in_loop(['const r = xs.map((x) => {', '  return fmt(x);'])).toBe(true);
		expect(in_loop(['function f() {', '  const a = 1;', '  return a;'])).toBe(false);
		expect(
			in_loop(['<script>let a;</script>', '{#each items as item}', '  <p>{fmt(item)}</p>'], true)
		).toBe(true);
		expect(
			in_loop(
				['<script>let a;</script>', '{#each items as item}{item}{/each}', '<p>{fmt(a)}</p>'],
				true
			)
		).toBe(false);
	});
});

describe('find_patterns', () => {
	const ds = '/app/src/lib/ds-ssr.ts';
	const util = '/app/src/lib/util.ts';
	const files = {
		[ds]: [
			"import x from 'x';",
			'export function splice() {',
			"\tspan('ds.splice', () => {",
			'\t\tfor (const { tag, el } of rendered) html = html.replace(tag, el);',
			'\t});',
			'}'
		].join('\n'),
		[util]: [
			'export function formatPrice(n, locale, currency) {',
			"\treturn new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);",
			'}'
		].join('\n')
	};
	const functions = [
		fn({ key: 'anon', name: '(anonymous)', path: ds, line: 3 }),
		fn({ key: 'fp', name: 'formatPrice', path: util, line: 1, calls: 480 })
	];

	it('names the rescan-per-item loop and the per-call formatter, with numbers, biggest win first', () => {
		const ledger = [
			row({
				path: ds,
				line: 4,
				code: files[ds].split('\n')[3].trim(),
				fn: 'anon',
				cpu_ms: 183,
				alloc_bytes: 1.8e9,
				gc_ms: 53
			}),
			row({ path: util, line: 2, code: files[util].split('\n')[1].trim(), fn: 'fp', cpu_ms: 57 })
		];
		const out = find_patterns({ ledger, functions, source: src_of(files) });
		expect(out.map((p) => p.kind)).toEqual(['rescan-in-loop', 'formatter-per-call']);
		const [rescan, fmt] = out;
		expect(rescan.sites[0]).toMatchObject({ line: 4, in_loop: true, fn_name: '(anonymous)' });
		expect(rescan.cost_ms).toBe(236);
		expect(rescan.save_ms).toBeGreaterThan(150);
		expect(rescan.evidence).toContain('183 ms of CPU');
		expect(fmt.evidence).toContain('formatPrice ran 480 times');
		expect(fmt.title).toBe('A new number or date formatter is built on every call');
	});

	it('a formatter built only when a cache misses is the fix, not the problem (the written change has that shape)', () => {
		const p = '/app/src/lib/money.ts';
		const hot = fn({ key: 'm', name: 'money', path: p, line: 1, calls: 400 });
		const kinds = (code: string) =>
			find_patterns({
				ledger: [row({ path: p, line: 3, code, fn: 'm', cpu_ms: 5 })],
				functions: [hot]
			}).map((x) => x.kind);
		expect(
			kinds(
				"if (!f) money.set(key, (f = new Intl.NumberFormat(locale, { style: 'currency', currency })));"
			)
		).toEqual([]);
		expect(kinds('f ??= new Intl.NumberFormat(locale);')).toEqual([]);
		expect(kinds('return cache.get(k) ?? cache.set(k, new Intl.Collator(locale)).get(k);')).toEqual(
			[]
		);
		// built on every call: still the problem
		expect(kinds('return new Intl.NumberFormat(locale).format(n);')).toEqual([
			'formatter-per-call'
		]);
		expect(kinds('list.push(new Intl.NumberFormat(locale));')).toEqual(['formatter-per-call']);
	});

	it("the USE of a formatter a cache built above is not 'the first use of one built here'", () => {
		const p = '/app/src/lib/money.ts';
		const hot = fn({ key: 'm', name: 'money', path: p, line: 1, calls: 400 });
		const lines = [
			'export function money(n, currency) {',
			'\tlet f = cache.get(currency);',
			"\tif (!f) cache.set(currency, (f = new Intl.NumberFormat('en-US', { currency })));",
			'\treturn f.format(n);',
			'}'
		];
		const use = find_patterns({
			ledger: [row({ path: p, line: 4, code: lines[3].trim(), fn: 'm', cpu_ms: 5 })],
			functions: [hot],
			source: src_of({ [p]: lines.join('\n') })
		});
		expect(use.map((x) => x.kind)).toEqual([]);
		// built right above on every call: its use line is where V8 charges it
		const every = [
			'export function money(n, currency) {',
			"\tconst f = new Intl.NumberFormat('en-US', { currency });",
			'\treturn f.format(n);',
			'}'
		];
		const hit = find_patterns({
			ledger: [row({ path: p, line: 3, code: every[2].trim(), fn: 'm', cpu_ms: 5 })],
			functions: [hot],
			source: src_of({ [p]: every.join('\n') })
		});
		expect(hit.map((x) => x.kind)).toEqual(['formatter-per-call']);
	});

	it('groups one pattern in several places into one item', () => {
		const ledger = [
			row({
				path: util,
				line: 2,
				code: 'return new Intl.NumberFormat(locale).format(n);',
				fn: 'fp',
				cpu_ms: 50
			}),
			row({ path: util, line: 9, code: 'return n.toLocaleString(locale);', fn: 'fp', cpu_ms: 20 })
		];
		const out = find_patterns({ ledger, functions });
		expect(out).toHaveLength(1);
		expect(out[0].sites.map((s) => s.line)).toEqual([2, 9]);
		expect(out[0].title).toContain('(2 places)');
	});

	it('stays quiet where the shape is there but the context or the cost is not', () => {
		const once = fn({ key: 'once', name: 'boot', path: '/app/src/boot.ts', line: 1, calls: 1 });
		const ledger = [
			// a formatter built by a function that ran once, outside any loop
			row({
				path: '/app/src/boot.ts',
				line: 2,
				code: 'const f = new Intl.NumberFormat(locale);',
				fn: 'once',
				cpu_ms: 5
			}),
			// a numeric += in a loop with no allocations is not string growth
			row({
				path: '/app/src/boot.ts',
				line: 3,
				code: 'for (const x of xs) total += x;',
				fn: 'once',
				cpu_ms: 2
			}),
			// a find outside a loop
			row({
				path: '/app/src/boot.ts',
				line: 4,
				code: 'const hit = xs.find((x) => x.id === id);',
				fn: 'once',
				cpu_ms: 3
			}),
			// the word in a string or a comment
			row({
				path: '/app/src/boot.ts',
				line: 5,
				code: "log('new Intl.NumberFormat'); // readFileSync(",
				fn: 'once',
				cpu_ms: 3
			})
		];
		expect(find_patterns({ ledger, functions: [once] })).toEqual([]);
	});

	it('string growth needs text added: a literal, a call answering text, or a name made text above; not a sum', () => {
		const p = '/app/src/lib/grow.ts';
		const f = fn({ key: 'g', name: 'grow', path: p, line: 1, calls: 1 });
		const lines = [
			'export function grow(items, specs) {',
			"\tlet html = '';",
			'\tlet s = 0;',
			'\tfor (const i of items) html += row(i);',
			'\tfor (const i of items) s += (i.stars + JSON.stringify(specs).length) % 7;',
			"\tfor (const i of items) out += '<li>' + i.name;",
			'\tfor (const i of items) out += i.tags.join(", ");',
			'\treturn html;',
			'}'
		];
		// each case alone in the function (a neighbour line would be looked at too)
		const kinds = (line: number) => {
			const only = lines.map((l, i) => (i + 1 === line || i < 3 || i >= 7 ? l : ''));
			return find_patterns({
				ledger: [
					row({
						path: p,
						line,
						code: lines[line - 1].trim(),
						fn: 'g',
						cpu_ms: 20,
						alloc_bytes: 40e6
					})
				],
				functions: [f],
				source: src_of({ [p]: only.join('\n') })
			}).map((x) => x.kind);
		};
		expect(kinds(4)).toEqual(['string-build']);
		expect(kinds(5)).toEqual([]);
		expect(kinds(6)).toEqual(['string-build']);
		expect(kinds(7)).toEqual(['string-build']);
	});

	it('a fixed table built in a component is flagged, but not in <script module>', () => {
		const icon = '/app/src/lib/Icon.svelte';
		const comp = fn({
			key: 'C:Icon',
			name: 'Icon',
			path: icon,
			line: 1,
			category: 'component',
			calls: 60
		});
		const src = [
			'<script module>',
			'\tconst M = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i, i]));',
			'</script>',
			'<script>',
			'\tconst T = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i, i]));',
			'</script>'
		].join('\n');
		const code = 'const T = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i, i]));';
		const hit = find_patterns({
			ledger: [row({ path: icon, line: 5, code, fn: 'C:Icon', cpu_ms: 14, alloc_bytes: 26e6 })],
			functions: [comp],
			source: src_of({ [icon]: src })
		});
		expect(hit.map((p) => p.kind)).toEqual(['table-per-call']);
		const miss = find_patterns({
			ledger: [row({ path: icon, line: 2, code, fn: 'C:Icon', cpu_ms: 14, alloc_bytes: 26e6 })],
			functions: [comp],
			source: src_of({ [icon]: src })
		});
		expect(miss).toEqual([]);
	});

	it('a search after a loop header on the same line counts; the header call itself does not', () => {
		const p = '/app/src/lib/one.ts';
		const once = fn({ key: 'o', name: 'one', path: p, line: 1, calls: 1 });
		const nested = row({
			path: p,
			line: 1,
			code: 'const out = products.map((pr) => brands.find((b) => b.id === pr.brand_id));',
			fn: 'o',
			cpu_ms: 9
		});
		expect(find_patterns({ ledger: [nested], functions: [once] }).map((x) => x.kind)).toEqual([
			'lookup-in-loop'
		]);
		const alone = row({
			path: p,
			line: 1,
			code: 'const hit = brands.find((b) => b.id === id);',
			fn: 'o',
			cpu_ms: 9
		});
		expect(find_patterns({ ledger: [alone], functions: [once] })).toEqual([]);
	});

	it('a true pattern worth under a millisecond is not reported', () => {
		const p = '/app/src/routes/heavy/PrimeSieve.svelte';
		const comp = fn({
			key: 'C:PrimeSieve',
			name: 'PrimeSieve',
			path: p,
			line: 1,
			category: 'component',
			calls: 3
		});
		const crumb = row({
			path: p,
			line: 25,
			code: "Primes below {limit.toLocaleString('de')}",
			fn: 'C:PrimeSieve',
			cpu_ms: 0.83
		});
		expect(find_patterns({ ledger: [crumb], functions: [comp] })).toEqual([]);
		expect(
			find_patterns({ ledger: [{ ...crumb, cpu_ms: 8 }], functions: [comp] }).map((x) => x.kind)
		).toEqual(['formatter-per-call']);
	});

	it('a locale method counts only with a locale or options: with none V8 reuses a cached formatter', () => {
		const p = '/app/src/lib/sort.ts';
		const hot = fn({ key: 's', name: 'cmp', path: p, line: 1, calls: 30000 });
		const at = (code: string) =>
			find_patterns({
				ledger: [row({ path: p, line: 2, code, fn: 's', cpu_ms: 40 })],
				functions: [hot]
			}).map((x) => x.kind);
		expect(at('return a.name.localeCompare(b.name);')).toEqual([]);
		expect(at("return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });")).toEqual([
			'formatter-per-call'
		]);
		expect(at('return n.toLocaleString();')).toEqual([]);
		expect(at('return n.toLocaleString(locale);')).toEqual(['formatter-per-call']);
	});

	it('a library called once per item is named after the library function', () => {
		const p = '/app/src/lib/ds.ts';
		const src = [
			'export function run(tags) {',
			'\treturn tags.map(async (tag) => {',
			'\t\treturn await render(tag);',
			'\t});',
			'}'
		].join('\n');
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 3,
					code: 'return await render(tag);',
					fn: 'a',
					lib_ms: 300,
					libs: [{ name: 'renderToString', pkg: '@lib/core', ms: 300 }]
				})
			],
			functions: [fn({ key: 'a', name: '(anonymous)', path: p, line: 2 })],
			source: src_of({ [p]: src })
		});
		expect(out.map((x) => x.kind)).toEqual(['library-per-item']);
		expect(out[0].title).toBe('renderToString (@lib/core) is called once per item');
		expect(out[0].evidence).toContain('300 ms inside @lib/core');
		expect(out[0].save_ms).toBe(150);
	});

	it('a thin wrapper’s site lists the caller lines that call it, through an instrument() alias, in a loop', () => {
		const p = '/app/src/lib/ds-ssr.ts';
		const src = [
			"import { renderToString as uiRender } from '@acme/core';", // 1
			'const render = (html) => uiRender(html);', // 2
			"const renderToString = instrument(render, 'ds.render');", // 3
			'export async function run(tags) {', // 4
			'\treturn Promise.all(', // 5
			'\t\ttags.map(async (tag) => {', // 6
			'\t\t\tlet el = await renderToString(tag);', // 7
			'\t\t\treturn await renderToString(el);', // 8
			'\t\t})', // 9
			'\t);', // 10
			'}' // 11
		].join('\n');
		const wrapper = fn({
			key: 'render',
			name: 'render',
			path: p,
			url: 'src/lib/ds-ssr.ts',
			line: 2,
			stacks: [
				{
					ms: 300,
					frames: [
						{ n: 'wrapped', f: 'profiler/span.js:9', c: 'profiler' },
						{ n: '(anonymous)', f: 'src/lib/ds-ssr.ts:6', c: 'app' }
					]
				}
			]
		} as Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path' | 'line'>);
		const arrow = fn({
			key: 'anon',
			name: '(anonymous)',
			path: p,
			url: 'src/lib/ds-ssr.ts',
			line: 6
		} as Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path' | 'line'>);
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 2,
					code: src.split('\n')[1],
					fn: 'render',
					lib_ms: 300,
					libs: [{ name: 'renderToString', pkg: '@acme/core', ms: 300 }]
				})
			],
			functions: [wrapper, arrow],
			source: src_of({ [p]: src })
		});
		// no V8 count and no loop on the wrapper's own line: the caller's loop is what makes it repeat
		expect(out.map((x) => x.kind)).toEqual(['library-per-item']);
		expect(out[0].sites[0].via?.map((v) => [v.line, v.in_loop])).toEqual([
			[7, true],
			[8, true]
		]);
	});

	it('a table sized by the input is not a fixed table; a timer awaited per turn is its own pattern', () => {
		const p = '/app/src/lib/util.ts';
		const hot = fn({ key: 'lev', name: 'lev', path: p, line: 1, calls: 400 });
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 2,
					code: 'const d = Array.from({ length: m + 1 }, (_, i) => [i]);',
					fn: 'lev',
					cpu_ms: 9,
					alloc_bytes: 4e6
				}),
				row({
					path: p,
					line: 3,
					code: 'for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));',
					fn: 'lev',
					cpu_ms: 1,
					lib_ms: 20,
					libs: [{ name: 'setImmediate', pkg: 'Node', ms: 20 }]
				})
			],
			functions: [hot]
		});
		expect(out.map((x) => x.kind)).toEqual(['yield-per-item']);
	});

	it('a build without sourcemaps: a compiled component line builds its table per render; a split spread is one statement', () => {
		const chunk = '/app/.svelte-kit/output/server/entries/pages/x/_page.svelte.js';
		const lines = [
			'function Card($$renderer, $$props) {',
			'\t$$renderer.component(($$renderer) => {',
			'\t\tconst ICONS = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`i${i}`, `M${i}`]));',
			'\t});',
			'}',
			'function index(items) {',
			'\treturn items.reduce((acc, p) => ({',
			'\t\t...acc,',
			'\t\t[p.id]: p',
			'\t}), {});',
			'}'
		];
		// no call counts (a compiled component is an anonymous callback): its module says what it is
		const inner = fn({ key: 'inner', name: '(anonymous)', path: chunk, line: 2 });
		const idx = fn({ key: 'idx', name: 'index', path: chunk, line: 6, calls: 1 });
		const out = find_patterns({
			ledger: [
				row({
					path: chunk,
					line: 3,
					code: lines[2].trim(),
					fn: 'inner',
					cpu_ms: 9,
					module: 'src/lib/Card.svelte'
				}),
				row({ path: chunk, line: 7, code: lines[6].trim(), fn: 'idx', cpu_ms: 14 })
			],
			functions: [inner, idx],
			source: src_of({ [chunk]: lines.join('\n') })
		});
		expect(out.map((p) => p.kind).sort()).toEqual(['spread-accumulate', 'table-per-call']);
		// the same table line in a plain module function that ran once: not per render
		const once = find_patterns({
			ledger: [row({ path: chunk, line: 3, code: lines[2].trim(), fn: 'inner', cpu_ms: 9 })],
			functions: [inner],
			source: src_of({ [chunk]: lines.join('\n') })
		});
		expect(once.some((p) => p.kind === 'table-per-call')).toBe(false);
	});

	it('copied on each step means the ACCUMULATOR spread: an item or call-argument spread is not it', () => {
		const p = '/app/src/lib/spread.ts';
		const f = fn({ key: 's', name: 'run', path: p, line: 1, calls: 5 });
		const kinds = (code: string) =>
			find_patterns({
				ledger: [row({ path: p, line: 2, code, fn: 's', cpu_ms: 5, alloc_bytes: 2e6 })],
				functions: [f]
			}).map((x) => x.kind);
		expect(kinds('return items.reduce((acc, i) => ({ ...acc, [i.id]: i }), {});')).toEqual([
			'spread-accumulate'
		]);
		expect(kinds('for (const x of xs) acc = [...acc, x];')).toEqual(['spread-accumulate']);
		expect(kinds('return items.map((i) => ({ ...i, price }));')).toEqual([]);
		expect(kinds('for (const c of chunks) out.push(...c);')).toEqual([]);
		expect(kinds('for (const r of rows) best = Math.max(best, ...r.values);')).toEqual([]);
	});

	it("Node's own functions are the runtime, not a library called per item", () => {
		const p = '/app/src/routes/api/+server.ts';
		const hot = fn({ key: 'h', name: 'GET', path: p, line: 1, calls: 16 });
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 3,
					code: 'await new Promise((r) => setTimeout(r, ms));',
					fn: 'h',
					cpu_ms: 0,
					lib_ms: 20,
					libs: [{ name: 'setTimeout', pkg: 'Node', ms: 20 }]
				})
			],
			functions: [hot]
		});
		expect(out).toEqual([]);
	});

	it('library calls per item group per library function', () => {
		const p = '/app/src/lib/ds.ts';
		const loop = fn({ key: 'a', name: 'run', path: p, line: 1, calls: 5 });
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 2,
					code: 'for (const t of tags) await render(t);',
					fn: 'a',
					lib_ms: 300,
					libs: [{ name: 'renderToString', pkg: '@lib/core', ms: 300 }]
				}),
				row({
					path: p,
					line: 3,
					code: 'for (const t of tags) await render2(t);',
					fn: 'a',
					lib_ms: 100,
					libs: [{ name: 'renderToString', pkg: '@lib/core', ms: 100 }]
				}),
				row({
					path: p,
					line: 4,
					code: 'for (const x of xs) await wait(x);',
					fn: 'a',
					lib_ms: 20,
					libs: [{ name: 'setImmediate', pkg: 'Node', ms: 20 }]
				})
			],
			functions: [loop]
		});
		// (Node's setImmediate is the runtime, not a library: not one of them)
		expect(out.map((x) => [x.title, x.sites.length])).toEqual([
			['renderToString (@lib/core) is called once per item (2 places)', 2]
		]);
	});

	it('a search inside a loop and a spread accumulator are named', () => {
		const p = '/app/src/lib/join.ts';
		const src = [
			'export function join(products, brands) {',
			'\tfor (const pr of products) {',
			'\t\tpr.brand = brands.find((b) => b.id === pr.brand_id);',
			'\t}',
			'\treturn products.reduce((acc, x) => ({ ...acc, [x.id]: x }), {});',
			'}'
		].join('\n');
		const j = fn({ key: 'j', name: 'join', path: p, line: 1, calls: 1 });
		const out = find_patterns({
			ledger: [
				row({ path: p, line: 3, code: src.split('\n')[2].trim(), fn: 'j', cpu_ms: 12 }),
				row({
					path: p,
					line: 5,
					code: src.split('\n')[4].trim(),
					fn: 'j',
					cpu_ms: 4,
					alloc_bytes: 3e6
				})
			],
			functions: [j],
			source: src_of({ [p]: src })
		});
		expect(out.map((x) => x.kind).sort()).toEqual(['lookup-in-loop', 'spread-accumulate']);
	});
});

describe('cache_rules', () => {
	it('what a Cache-Control allows: shared max-age wins, no-store, private', () => {
		expect(cache_rules('public, max-age=60, s-maxage=300')).toEqual({ max_age: 300 });
		expect(cache_rules('private, max-age=30')).toEqual({ private: true, max_age: 30 });
		expect(cache_rules('no-store')).toEqual({ no_store: true });
		expect(cache_rules('must-revalidate')).toBeUndefined();
		expect(cache_rules('no-cache')).toEqual({ no_cache: true });
		expect(cache_rules('public, max-age=0')).toEqual({ no_cache: true });
		expect(cache_rules(undefined)).toBeUndefined();
	});

	it('a same-answer site carries what the service said about keeping it', () => {
		const at = { path: '/app/src/routes/+page.server.ts', line: 4 };
		const call = (start: number) => ({
			start,
			ms: 30,
			target: 'GET api/reviews',
			at,
			scope: '/p',
			exact: 'GET https://x/api/reviews',
			cache: 'public, max-age=300'
		});
		const p = find_same_answers({
			calls: [call(0)],
			stable: new Set(['GET https://x/api/reviews'])
		})!;
		expect(p.sites[0].upstream_cache).toEqual({ max_age: 300 });
	});
});

describe('find_wait_patterns', () => {
	const p = '/app/src/routes/+page.server.ts';
	const src = [
		'export async function load() {',
		'\tconst items = [];',
		'\tfor (const id of ids) {',
		'\t\titems.push(await getItem(id));',
		'\t}',
		'\treturn { items };',
		'}'
	].join('\n');
	const source = (path: string, a: number, b: number) =>
		path === p ? { start: a, lines: src.split('\n').slice(a - 1, b) } : undefined;
	const at = { path: p, line: 4 };

	it('calls from one line that ran one after another: the waits add up, the saving is all but the longest', () => {
		const calls = [
			{ start: 0, ms: 40, target: 'GET api/items/:id', at, scope: '/p' },
			{ start: 41, ms: 60, target: 'GET api/items/:id', at, scope: '/p' },
			{ start: 102, ms: 50, target: 'GET api/items/:id', at, scope: '/p' },
			{ start: 153, ms: 30, target: 'GET api/items/:id', at, scope: '/p' }
		];
		const out = find_wait_patterns({ calls, source });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			kind: 'waits-in-a-row',
			wait: true,
			cost_ms: 180,
			save_ms: 120
		});
		expect(out[0].sites[0]).toMatchObject({
			file: 'src/routes/+page.server.ts',
			line: 4,
			calls: 4,
			in_loop: true,
			code: 'items.push(await getItem(id));'
		});
		expect(out[0].evidence).toBe('4 calls to GET api/items/:id, 180 ms of waiting in a row');
	});

	it('calls whose each asks with the answer before it are the program, not a chain — independent ones are', () => {
		const q = '/app/src/routes/x/+page.server.ts';
		const code = [
			'export async function load() {',
			"\tconst step1 = await svc('a');",
			'\tconst step2 = await svc(`b-${step1.name}`);',
			'\tconst id = step2.id;',
			'\tconst step3 = await svc(id);',
			"\tconst user = await svc('user');",
			"\tconst cart = await svc('cart');",
			"\tconst promos = await svc('promos');",
			'}'
		].join('\n');
		const src2 = (path: string, a: number, b: number) =>
			path === q ? { start: a, lines: code.split('\n').slice(a - 1, b) } : undefined;
		const helper = { path: q, line: 40 };
		const c = (start: number, line: number) => ({
			start,
			ms: 20,
			target: 'GET api/x',
			at: helper,
			outer: { path: q, line },
			scope: '/p'
		});
		// step1 → step2 → (through `id`) step3: every link needs the one before
		expect(find_wait_patterns({ calls: [c(0, 2), c(21, 3), c(42, 5)], source: src2 })).toEqual([]);
		// (without the source to read, the same timing would read as a chain)
		expect(find_wait_patterns({ calls: [c(0, 2), c(21, 3), c(42, 5)] })[0].sites[0].calls).toBe(3);
		// user → cart → promos: none reads another
		expect(
			find_wait_patterns({ calls: [c(0, 6), c(21, 7), c(42, 8)], source: src2 })[0].sites[0].calls
		).toBe(3);
		// both chains through the one helper line, far apart in time: two places, not the longest only
		const both = find_wait_patterns({
			calls: [c(0, 6), c(21, 7), c(42, 8), c(500, 6), c(521, 7)],
			source: src2
		})[0];
		expect(both.sites.map((s) => s.calls)).toEqual([3, 2]);
	});

	it('a loop whose turn feeds the next (a cursor) cannot run its calls together', () => {
		const q = '/app/src/routes/y/+page.server.ts';
		const code = [
			'export async function load() {',
			'\tlet cursor = null;',
			'\tfor (let i = 0; i < 5; i++) {',
			'\t\tcursor = (await page(cursor)).next;',
			'\t}',
			'}'
		].join('\n');
		const src2 = (path: string, a: number, b: number) =>
			path === q ? { start: a, lines: code.split('\n').slice(a - 1, b) } : undefined;
		const at2 = { path: q, line: 4 };
		const calls = [0, 21, 42, 63].map((start) => ({
			start,
			ms: 20,
			target: 'GET api/page',
			at: at2,
			scope: '/p'
		}));
		expect(find_wait_patterns({ calls, source: src2 })).toEqual([]);
	});

	it('calls one after another from ONE line that runs no loop are nested, not a missed Promise.all', () => {
		// a build without maps folds `const a = await f(); const b = await f(a.x)` into one line
		const q = '/app/src/routes/w/+page.server.ts';
		const code = ['export async function load() {', '\tconst c = await f(`c-${(await f(`b-${(await f("a")).x}`)).x}`);', '}'].join('\n');
		const src2 = (path: string, a: number, b: number) =>
			path === q ? { start: a, lines: code.split('\n').slice(a - 1, b) } : undefined;
		const calls = [0, 21, 42].map((start) => ({
			start,
			ms: 20,
			target: 'GET api/step',
			at: { path: q, line: 2 },
			scope: '/p'
		}));
		expect(find_wait_patterns({ calls, source: src2 })).toEqual([]);
	});

	it('one slow call holding a batch: named with the gap it costs; an even batch is quiet', () => {
		const q = '/app/src/routes/z/+page.server.ts';
		const helper = { path: q, line: 5 };
		const c = (start: number, ms: number, t: string) => ({
			start,
			ms,
			target: `GET api/${t}`,
			at: helper,
			outer: { path: q, line: 20 },
			scope: '/p'
		});
		const out = find_wait_patterns({
			calls: [c(0, 10, 'nav'), c(0.2, 12, 'crumbs'), c(0.4, 80, 'recs')]
		});
		const p = out.find((x) => x.kind === 'batch-straggler')!;
		expect(p).toMatchObject({ save_ms: 68, wait: true });
		expect(p.sites[0]).toMatchObject({ line: 20, calls: 3, target: 'GET api/recs', wait_ms: 80 });
		// four calls of about the same length: already parallel, nothing holds them
		expect(
			find_wait_patterns({
				calls: [c(0, 20, 'a'), c(0.1, 22, 'b'), c(0.2, 19, 'c'), c(0.3, 21, 'd')]
			}).find((x) => x.kind === 'batch-straggler')
		).toBeUndefined();
	});

	it('review: a call from another line starting alongside is not this chain’s batch; a straggler needs a Promise.all', () => {
		const q = '/app/src/routes/w/+page.server.ts';
		const helper = { path: q, line: 3 };
		const c = (start: number, line: number) => ({
			start,
			ms: 20,
			target: 'GET api/x',
			at: helper,
			outer: { path: q, line },
			scope: '/p'
		});
		// user → cart → promos from lines 6-8; a call from line 30 starts with `user`: the chain stands
		expect(
			find_wait_patterns({ calls: [c(0, 6), c(0.3, 30), c(21, 7), c(42, 8)] })[0].sites[0].calls
		).toBe(3);
		const code = [
			'',
			'',
			'async function get() {}',
			'export const load = async () => {',
			'\tconst a = get(); const b = get(); const s = get();',
			'\treturn { a: await a, b: await b, s };',
			'};'
		].join('\n');
		const src = (p: string, a: number, b: number) =>
			p === q ? { start: a, lines: code.split('\n').slice(a - 1, b) } : undefined;
		const s = (start: number, ms: number) => ({
			start,
			ms,
			target: 'GET api/s',
			at: helper,
			outer: { path: q, line: 5 },
			scope: '/p'
		});
		// started together, never awaited together (a streamed value): no straggler
		expect(
			find_wait_patterns({ calls: [s(0, 10), s(0.2, 12), s(0.4, 80)], source: src }).find(
				(x) => x.kind === 'batch-straggler'
			)
		).toBeUndefined();
	});

	it('a Promise.all batch right after a chain is not a link in it', () => {
		// user → cart → promos one after another, then nav + footer + seo started together
		const c = (start: number, ms: number, t: string) => ({
			start,
			ms,
			target: `GET api/${t}`,
			at,
			scope: '/p'
		});
		const out = find_wait_patterns({
			calls: [
				c(0, 30, 'user'),
				c(31, 25, 'cart'),
				c(57, 20, 'promos'),
				c(78, 20, 'nav'),
				c(78, 22, 'footer'),
				c(78.2, 19, 'seo')
			],
			source
		});
		expect(out[0].sites[0].calls).toBe(3);
		expect(out[0]).toMatchObject({ cost_ms: 75, save_ms: 45 });
		expect(out[0].chains![0].map((x) => x.start)).toEqual([0, 31, 57]);
	});

	it('two awaits of a helper written on two lines are a chain; its callers show as where to fix', () => {
		const q = '/app/src/routes/+page.server.ts';
		const s2 = [
			'async function callService(name) {',
			'\tconst res = await fetch(url + name);',
			'\treturn res.json();',
			'}',
			'export async function load() {',
			"\tconst pricing = await callService('pricing');",
			"\tconst inventory = await callService('inventory');",
			'}'
		].join('\n');
		const src2 = (path: string, a: number, b: number) =>
			path === q ? { start: a, lines: s2.split('\n').slice(a - 1, b) } : undefined;
		const helper = { path: q, line: 2 };
		const out = find_wait_patterns({
			calls: [
				{
					start: 0,
					ms: 40,
					target: 'GET api/pricing',
					at: helper,
					outer: { path: q, line: 6 },
					scope: '/p'
				},
				{
					start: 41,
					ms: 35,
					target: 'GET api/inventory',
					at: helper,
					outer: { path: q, line: 7 },
					scope: '/p'
				}
			],
			source: src2
		});
		expect(out).toHaveLength(1);
		expect(out[0].save_ms).toBe(35);
		expect(out[0].sites[0].via?.map((v) => [v.line, v.code])).toEqual([
			[6, "const pricing = await callService('pricing');"],
			[7, "const inventory = await callService('inventory');"]
		]);
		// the same helper called twice from ONE line (a loop of two) is not enough to call it a chain
		const one = find_wait_patterns({
			calls: [
				{ start: 0, ms: 40, target: 'GET x', at: helper, outer: { path: q, line: 6 }, scope: '/p' },
				{ start: 41, ms: 35, target: 'GET x', at: helper, outer: { path: q, line: 6 }, scope: '/p' }
			],
			source: src2
		});
		expect(one).toEqual([]);
	});

	it('calls that overlapped (already together), or from different pages, are no chain', () => {
		const together = [0, 1, 2, 3].map((i) => ({
			start: i,
			ms: 50,
			target: 'GET x',
			at,
			scope: '/p'
		}));
		expect(find_wait_patterns({ calls: together, source })).toEqual([]);
		const pages = [0, 1, 2].map((i) => ({
			start: i * 60,
			ms: 50,
			target: 'GET x',
			at,
			scope: '/p' + i
		}));
		expect(find_wait_patterns({ calls: pages, source })).toEqual([]);
	});
});

describe('pattern_deltas', () => {
	const pat = (kind: string, cost: number, lib?: string) =>
		({
			kind,
			title: kind + (lib ? ' ' + lib : ''),
			fix: '',
			sites: [{ libs: lib ? [lib] : undefined }],
			cost_ms: cost,
			alloc_bytes: 0,
			save_ms: cost / 2,
			evidence: ''
		}) as unknown as Pattern;
	it('says what a change fixed, brought in, and moved; library patterns match per library', () => {
		const a = [
			pat('rescan-in-loop', 200),
			pat('formatter-per-call', 100),
			pat('library-per-item', 380, 'renderToString (@x)'),
			pat('sort-per-call', 10)
		];
		const b = [
			pat('formatter-per-call', 20),
			pat('library-per-item', 385, 'renderToString (@x)'),
			pat('library-per-item', 30, 'parse (@y)'),
			pat('sort-per-call', 15)
		];
		const d = pattern_deltas(a, b);
		expect(d.map((x) => [x.kind, x.status])).toEqual([
			['rescan-in-loop', 'fixed'],
			['library-per-item', 'new'],
			['sort-per-call', 'worse'],
			['formatter-per-call', 'better'],
			['library-per-item', 'same']
		]);
		expect(d[0]).toMatchObject({ a_ms: 200, b_ms: 0, d_ms: -200 });
	});

	it('per render: a CPU pattern over 3 renders against 6 is not "better" for having fewer renders; a wait is one render', () => {
		const a = [
			pat('rescan-in-loop', 300),
			{ ...pat('waits-in-a-row', 140), wait: true } as Pattern
		];
		const b = [
			pat('rescan-in-loop', 600),
			{ ...pat('waits-in-a-row', 140), wait: true } as Pattern
		];
		const d = pattern_deltas(a, b, 3, 6);
		expect(d.find((x) => x.kind === 'rescan-in-loop')).toMatchObject({
			a_ms: 100,
			b_ms: 100,
			status: 'same',
			a_save: 50,
			b_save: 50
		});
		expect(d.find((x) => x.kind === 'waits-in-a-row')).toMatchObject({
			a_ms: 140,
			b_ms: 140,
			status: 'same'
		});
	});

	it('fix check: wait patterns over the same calls promise their largest move, not their sum; a whole-page cache promises nothing', () => {
		const page = (runs: number[]) => ({ trigger: 'page', runs }) as never;
		const w = (kind: string, save: number) =>
			({ kind, status: 'better', a_save: save, b_save: 0, wait: true }) as never;
		const d = [
			w('batch-straggler', 68),
			w('same-answer', 67),
			{
				kind: 'almost-same-document',
				status: 'better',
				a_save: 162,
				b_save: 94,
				wait: true
			} as never
		];
		expect(fix_check_of(d, page([163, 163, 163]), page([94, 94, 94]))).toMatchObject({
			predicted_ms: 68,
			verdict: 'as-expected'
		});
	});

	it('fix check: what the fixed patterns promised against what the median render measured', () => {
		const page = (runs: number[]) => ({ trigger: 'page', runs }) as never;
		const d = pattern_deltas(
			[pat('rescan-in-loop', 300), pat('formatter-per-call', 90)],
			[pat('formatter-per-call', 30)],
			3,
			3
		);
		// promised: rescan 50 (fixed) + formatter 15 − 5 (better) = 60 ms per render
		expect(fix_check_of(d, page([500, 510, 520]), page([450, 455, 460]))).toEqual({
			predicted_ms: 60,
			measured_ms: 55,
			verdict: 'as-expected'
		});
		expect(fix_check_of(d, page([500, 510, 520]), page([500, 505, 510]))).toMatchObject({
			measured_ms: 5,
			verdict: 'less'
		});
		expect(fix_check_of(d, page([500, 510, 520]), page([300, 310, 320]))).toMatchObject({
			verdict: 'more'
		});
		// nothing fixed, no check
		expect(
			fix_check_of(
				pattern_deltas([pat('sort-per-call', 10)], [pat('sort-per-call', 10)]),
				page([1]),
				page([1])
			)
		).toBeUndefined();
	});

	it('still_there: the share of an older pattern still flagged, by its own sites, matched by code', () => {
		const w = (codes: [string, number][]) =>
			({
				kind: 'waits-in-a-row',
				title: `Waits in a row (${codes.length} places)`,
				sites: codes.map(([code, wait_ms], i) => ({ file: 'r.ts', line: 10 + i, code, wait_ms }))
			}) as never;
		const a = [
			w([
				['const a = await x();', 60],
				['for (const p of ps) s.push(await y(p));', 40]
			])
		];
		// the loop fixed; the first chain still flagged, moved down by an edit (same code, new line)
		expect(still_there(a, [w([['const a = await x();', 20]])]).get('Waits in a row')).toBeCloseTo(
			0.6
		);
		// every old site gone, a new wait flagged elsewhere: nothing of the old one is left
		expect(
			still_there(a, [w([['const [u, c] = await Promise.all(…);', 30]])]).get('Waits in a row')
		).toBe(0);
	});

	it('review fixes: code-less sites give no verdict; unread work folded away in B is still there; a clean B has none; a covered fix is worth its own saving', () => {
		const w = (codes: [string, number][]) =>
			({
				kind: 'waits-in-a-row',
				title: 'Waits in a row',
				sites: codes.map(([code, wait_ms], i) => ({ file: 'r.ts', line: 10 + i, code, wait_ms }))
			}) as never;
		// no site carries its code: nothing to judge by
		expect(still_there([w([['', 60]])], [w([['x', 1]])]).has('Waits in a row')).toBe(false);

		const page = (runs: number[], extra: object = {}) =>
			({ trigger: 'page', runs, ...extra }) as never;
		const del = 'Delete work for data nothing reads (freshest)';
		const fa = {
			now_ms: 300,
			after_ms: 150,
			cpu_ms: 50,
			wait_ms: 50,
			delete_ms: 50,
			parts: [
				{
					title: 'Waits in a row',
					kind: 'waits-in-a-row',
					ms: 100,
					wait: true,
					with: ['Repeat request']
				},
				{ title: del, kind: 'unread-work', ms: 50, wait: false }
			]
		};
		const none = [
			{
				kind: 'waits-in-a-row',
				title: 'Waits in a row',
				status: 'same',
				a_save: 100,
				b_save: 100,
				wait: true
			},
			{
				kind: 'repeat-request',
				title: 'Repeat request',
				status: 'same',
				a_save: 20,
				b_save: 20,
				wait: true
			}
		] as never;
		// B still has the unread work, only folded under another part: not deleted
		const fb_folded = {
			now_ms: 300,
			after_ms: 200,
			cpu_ms: 0,
			wait_ms: 0,
			delete_ms: 0,
			parts: [{ title: 'Big fix', kind: 'deep-copy', ms: 60, wait: false, with: [del] }]
		};
		expect(fix_check_of(none, page([300]), page([290]), fa, fb_folded)).toBeUndefined();
		// B clean (a 200 render with no forecast at all): the unread work is gone
		expect(fix_check_of(none, page([300]), page([250]), fa, undefined)).toMatchObject({
			predicted_ms: 50
		});
		// only the covered repeat request fixed (20 of the part's 100): 20, not the whole part
		const covered = [
			{
				kind: 'waits-in-a-row',
				title: 'Waits in a row',
				status: 'same',
				a_save: 100,
				b_save: 100,
				wait: true
			},
			{
				kind: 'repeat-request',
				title: 'Repeat request',
				status: 'fixed',
				a_save: 20,
				b_save: 0,
				wait: true
			}
		] as never;
		expect(fix_check_of(covered, page([300]), page([280]), fa, fb_folded)).toMatchObject({
			predicted_ms: 20
		});
	});

	it("fix check with the older report's forecast: its parts that got done, counted its way", () => {
		const page = (runs: number[]) => ({ trigger: 'page', runs }) as never;
		const d = [
			{
				kind: 'waits-in-a-row',
				title: 'Waits in a row (3 places)',
				status: 'fixed',
				a_save: 150,
				b_save: 0,
				wait: true
			},
			// covered by the waits: its own move is not added again
			{
				kind: 'repeat-request',
				title: 'Repeat request',
				status: 'fixed',
				a_save: 30,
				b_save: 0,
				wait: true
			},
			// shrank by half: half its part (the title's count changed with it)
			{
				kind: 'formatter-per-call',
				title: 'Formatter per call (1 place)',
				status: 'better',
				a_save: 60,
				b_save: 30,
				wait: false
			},
			{
				kind: 'date-parse',
				title: 'Dates parsed',
				status: 'same',
				a_save: 10,
				b_save: 10,
				wait: false
			}
		] as never;
		const fa = {
			now_ms: 500,
			after_ms: 200,
			cpu_ms: 70,
			wait_ms: 150,
			delete_ms: 80,
			caps: { wait: 200, cpu: 300 },
			parts: [
				{
					title: 'Waits in a row (3 places)',
					kind: 'waits-in-a-row',
					ms: 150,
					wait: true,
					with: ['Repeat request']
				},
				{
					title: 'Delete work for data nothing reads (freshest)',
					kind: 'unread-work',
					ms: 80,
					wait: false
				},
				{ title: 'Formatter per call (3 places)', kind: 'formatter-per-call', ms: 60, wait: false },
				{ title: 'Dates parsed', kind: 'date-parse', ms: 10, wait: false }
			]
		};
		// the newer report no longer has the unread work: deleted
		const fb = { now_ms: 240, after_ms: 230, cpu_ms: 10, wait_ms: 0, delete_ms: 0, parts: [] };
		// 150 (waits, repeat-request folded in) + 80 (deleted) + 30 (half the formatter) = 260
		expect(fix_check_of(d, page([500]), page([240]), fa, fb)).toMatchObject({
			predicted_ms: 260,
			measured_ms: 260,
			verdict: 'as-expected'
		});
		// the waits "shrank" 150 → 40 by size, but by their own sites every old chain is gone (the
		// newer report flags other calls): done whole
		// (the repeat request it covers left alone here, so the waits alone decide)
		const shrank = (d as { title: string }[]).map((x) =>
			x.title.startsWith('Waits')
				? { ...x, status: 'better', b_save: 40 }
				: x.title === 'Repeat request'
					? { ...x, status: 'same', b_save: 30 }
					: x
		) as never;
		expect(
			fix_check_of(shrank, page([500]), page([240]), fa, fb, new Map([['Waits in a row', 0]]))
		).toMatchObject({ predicted_ms: 260 });
		// without its sites, by its size: 110 of the 150
		expect(fix_check_of(shrank, page([500]), page([240]), fa, fb, new Map())).toMatchObject({
			predicted_ms: 220
		});
		// half its sites still flagged: the size (110 of 150) says more
		expect(
			fix_check_of(shrank, page([500]), page([240]), fa, fb, new Map([['Waits in a row', 0.5]]))
		).toMatchObject({ predicted_ms: 220 });
		// the unread work still there: not counted
		expect(
			fix_check_of(d, page([500]), page([320]), fa, {
				...fb,
				parts: [
					{
						title: 'Delete work for data nothing reads (freshest)',
						kind: 'unread-work',
						ms: 80,
						wait: false
					}
				]
			})
		).toMatchObject({ predicted_ms: 180 });
	});
});

describe('findings link to the pattern that explains them', () => {
	it('by a shared line, a caller line, the row they open, or the calls they name', () => {
		const pats = [
			{
				kind: 'waits-in-a-row',
				title: 'w',
				fix: '',
				cost_ms: 1,
				alloc_bytes: 0,
				save_ms: 1,
				evidence: '',
				sites: [
					{
						path: '/app/src/routes/+page.server.ts',
						file: 'src/routes/+page.server.ts',
						line: 23,
						code: '',
						cpu_ms: 0,
						alloc_bytes: 0,
						gc_ms: 0,
						in_loop: true,
						target: 'GET api.test/product/:id',
						via: [
							{
								path: '/app/src/routes/+page.server.ts',
								file: 'src/routes/+page.server.ts',
								line: 79,
								code: '',
								in_loop: true
							}
						]
					}
				]
			},
			{
				kind: 'deep-copy',
				title: 'd',
				fix: '',
				cost_ms: 1,
				alloc_bytes: 0,
				save_ms: 1,
				evidence: '',
				sites: [
					{
						path: '/app/src/lib/mappers.ts',
						file: 'src/lib/mappers.ts',
						line: 29,
						code: '',
						cpu_ms: 0,
						alloc_bytes: 0,
						gc_ms: 0,
						in_loop: false,
						fn: 'toProductVM /app/src/lib/mappers.ts',
						fn_name: 'render'
					}
				]
			}
		] as unknown as Pattern[];
		const findings = [
			{
				severity: 'warn',
				code: 'n-plus-one',
				message: '16 calls to api.test/product/:id — one per item.'
			},
			{
				severity: 'warn',
				code: 'span-repeat',
				message: 'stock.lookup ran 16 times (load (routes/+page.server.ts:79)), 112 ms.'
			},
			{
				severity: 'info',
				code: 'memo-candidate',
				message: 'toProductVM runs 48 times',
				anchor: 'fn:toProductVM /app/src/lib/mappers.ts'
			},
			{ severity: 'warn', code: 'loop-stall', message: 'The event loop stalled (p99).' },
			// a plain word that is also a site's function name, in prose: no link
			{
				severity: 'warn',
				code: 'span-slow',
				message: 'ds.all took 158 ms of the render (processTags (lib/other.ts:38)).'
			}
		] as Parameters<typeof link_patterns>[0];
		link_patterns(findings, pats, { functions: [], components: [] });
		expect(findings.map((f) => f.pattern)).toEqual([0, 0, 1, undefined, undefined]);
	});
});

describe('audit false positives (normal pages)', () => {
	it('a template literal’s ${} parts are tokenized', () => {
		expect(tokens('`t${(i + k) % 40}`')).toEqual([
			'""',
			'(',
			'(',
			'i',
			'+',
			'k',
			')',
			'%',
			'0',
			')'
		]);
		expect(tokens('`a${ { x: 1 }.x }b`')).toEqual([
			'""',
			'(',
			'{',
			'x',
			':',
			'0',
			'}',
			'.',
			'x',
			')'
		]);
	});

	const p = '/app/src/routes/heavy/HeavyRow.svelte';
	const comp = fn({
		key: 'C:HeavyRow',
		name: 'HeavyRow',
		path: p,
		line: 1,
		category: 'component',
		calls: 800
	});
	const at = (line: number, code: string, cpu_ms = 5, alloc_bytes = 4e6) =>
		row({ path: p, line, code, fn: 'C:HeavyRow', cpu_ms, alloc_bytes });

	it('a table built from the call’s own values is not a fixed table; one built from its own index is', () => {
		const outer = at(
			17,
			"const tags = Array.from({ length: 6 }, (_, k) => `t${(i + k) % 40}`).join(' ');"
		);
		expect(find_patterns({ ledger: [outer], functions: [comp] })).toEqual([]);
		// a builder that goes on to the next lines: its body is unseen, so it is not called fixed
		expect(
			find_patterns({
				ledger: [at(34, 'rows: Array.from({ length: 60 }, (_, r) => ({')],
				functions: [comp]
			})
		).toEqual([]);
		const fixed = at(
			13,
			'...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`icon-${i}`, `M${i} ${i}h${i}v${i}z`]))'
		);
		expect(find_patterns({ ledger: [fixed], functions: [comp] }).map((x) => x.kind)).toEqual([
			'table-per-call'
		]);
	});

	it('a Date from a number is not date parsing; a Date from text is', () => {
		expect(
			find_patterns({
				ledger: [
					at(15, 'const ts = when.format(new Date(1_600_000_000_000 + i * 86_400_000));', 5, 0)
				],
				functions: [comp]
			})
		).toEqual([]);
		expect(
			find_patterns({
				ledger: [at(15, 'const ts = new Date(item.createdAt);', 5, 0)],
				functions: [comp]
			}).map((x) => x.kind)
		).toEqual(['date-parse']);
	});
});

describe('inferno round: context fixes', () => {
	const files: Record<string, string> = {
		'/app/src/lib/i18n.ts': [
			'function lookup(key, table) {',
			'\tfor (const [k, v] of Object.entries(table)) if (k === key) return v;',
			'}',
			'function plural(key, n, locale) {',
			'\tconst rules = new Intl.PluralRules(locale);',
			'\treturn lookup(`${key}.${rules.select(n)}`);',
			'}'
		].join('\n'),
		'/app/src/lib/catalog.ts': [
			'export function attach(products) {',
			'\tconst out = [];',
			'\tfor (const p of products) {',
			'\t\tconst brand = BRANDS.find((b) => b.id === p.brandId);',
			'\t\tout.push({ ...p, brand });',
			'\t}',
			'\treturn out;',
			'}'
		].join('\n'),
		'/app/src/lib/Card.svelte': [
			'<script>',
			'\t// a fixed table (belongs in <script module>)',
			'\tconst ICONS = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`i${i}`, `M${i}`]));',
			'</script>'
		].join('\n'),
		'/app/src/lib/ds.ts': [
			'function swap(html, from, to) {',
			'\treturn html.replace(from, to);',
			'}',
			'export function all(html, tags) {',
			'\tfor (const t of tags) {',
			'\t\thtml = swap(html, t, t);',
			'\t}',
			'}'
		].join('\n')
	};
	const source = src_of(files);
	const kinds = (ledger: LedgerLine[], functions: FrameStat[]) =>
		find_patterns({ ledger, functions, source }).map((x) => x.kind);

	it('a dedupe by indexOf inside filter is a list search, not a string rescan', () => {
		const p = '/app/src/lib/Button.svelte';
		const c = fn({
			key: 'C:Button',
			name: 'Button',
			path: p,
			line: 1,
			category: 'component',
			calls: 300
		});
		const code =
			"const cx = (...parts) => parts.filter(Boolean).join(' ').split(/\\s+/).filter((c, i, a) => a.indexOf(c) === i).join(' ');";
		expect(kinds([row({ path: p, line: 7, code, fn: 'C:Button', cpu_ms: 6 })], [c])).toEqual([
			'lookup-in-loop'
		]);
	});

	it('walking entries to find one key', () => {
		const f = fn({
			key: 'lookup',
			name: 'lookup',
			path: '/app/src/lib/i18n.ts',
			line: 1,
			calls: 600
		});
		expect(
			kinds(
				[
					row({
						path: f.path,
						line: 2,
						code: files[f.path].split('\n')[1].trim(),
						fn: 'lookup',
						cpu_ms: 9,
						alloc_bytes: 14e6
					})
				],
				[f]
			)
		).toEqual(['scan-for-key']);
	});

	it('a formatter built on one line and used (and charged) on the next', () => {
		const f = fn({
			key: 'plural',
			name: 'plural',
			path: '/app/src/lib/i18n.ts',
			line: 4,
			calls: 600
		});
		expect(
			kinds(
				[
					row({
						path: f.path,
						line: 6,
						code: files[f.path].split('\n')[5].trim(),
						fn: 'plural',
						cpu_ms: 9
					})
				],
				[f]
			)
		).toEqual(['formatter-per-call']);
	});

	it('a callback defined on the costly line is read in the function around it', () => {
		const outer = fn({
			key: 'attach',
			name: 'attach',
			path: '/app/src/lib/catalog.ts',
			line: 1,
			calls: 1
		});
		const cb = fn({
			key: 'cb',
			name: '(anonymous)',
			path: '/app/src/lib/catalog.ts',
			line: 4,
			calls: 400000
		});
		expect(
			kinds(
				[
					row({
						path: cb.path,
						line: 4,
						code: files[cb.path].split('\n')[3].trim(),
						fn: 'cb',
						cpu_ms: 30
					})
				],
				[outer, cb]
			)
		).toEqual(['lookup-in-loop']);
	});

	it('`<script module>` in a comment is not a module script', () => {
		const c = fn({
			key: 'C:Card',
			name: 'Card',
			path: '/app/src/lib/Card.svelte',
			line: 1,
			category: 'component',
			calls: 120
		});
		expect(
			kinds(
				[
					row({
						path: c.path,
						line: 3,
						code: files[c.path].split('\n')[2].trim(),
						fn: 'C:Card',
						cpu_ms: 27,
						alloc_bytes: 1e8
					})
				],
				[c]
			)
		).toEqual(['table-per-call']);
	});

	it('a line with no loop of its own, called from a caller’s loop, runs per item', () => {
		const swap = fn({
			key: 'swap',
			name: 'swap',
			path: '/app/src/lib/ds.ts',
			url: 'src/lib/ds.ts',
			line: 1,
			self_ms: 30,
			stacks: [{ ms: 30, frames: [{ n: 'all', f: 'src/lib/ds.ts:4', c: 'app' }] }]
		} as Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path' | 'line'>);
		const all = fn({
			key: 'all',
			name: 'all',
			path: '/app/src/lib/ds.ts',
			url: 'src/lib/ds.ts',
			line: 4
		} as Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path' | 'line'>);
		const out = find_patterns({
			ledger: [
				row({
					path: swap.path,
					line: 2,
					code: 'return html.replace(from, to);',
					fn: 'swap',
					cpu_ms: 30,
					alloc_bytes: 5e6
				})
			],
			functions: [swap, all],
			source
		});
		expect(out.map((x) => x.kind)).toEqual(['rescan-in-loop']);
		expect(out[0].sites[0].via?.map((v) => [v.line, v.in_loop])).toEqual([[6, true]]);
	});
});

describe('site context', () => {
	it('each site carries two lines each side of it, when the source is there', () => {
		const p = '/app/src/lib/i18n.ts';
		const src = [
			'// a',
			'// b',
			'function lookup(key, table) {',
			'\tfor (const [k, v] of Object.entries(table)) if (k === key) return v;',
			'}',
			'// c',
			'// d'
		].join('\n');
		const f = fn({ key: 'lookup', name: 'lookup', path: p, line: 3, calls: 600 });
		const out = find_patterns({
			ledger: [row({ path: p, line: 4, code: src.split('\n')[3].trim(), fn: 'lookup', cpu_ms: 9 })],
			functions: [f],
			source: src_of({ [p]: src })
		});
		expect(out[0].sites[0].context).toEqual({ start: 2, lines: src.split('\n').slice(1, 6) });
	});
});

describe('repeat-request', () => {
	it('the exact same read made again in one render; its callers are listed; writes and other pages are not repeats', () => {
		const p = '/app/src/routes/+page.server.ts';
		const src = [
			'async function svc(name) {',
			'\treturn (await fetch(url + name)).json();',
			'}',
			'const a = await svc("session");',
			'const b = await svc("session");',
			'const c = await svc("session");'
		].join('\n');
		const at = { path: p, line: 2 };
		const call = (start: number, line: number, extra: Partial<WaitCall> = {}): WaitCall => ({
			start,
			ms: 15,
			target: 'GET api/session',
			at,
			outer: { path: p, line },
			scope: '/p',
			exact: 'GET http://x/api/session?ms=15',
			...extra
		});
		const out = find_wait_patterns({
			calls: [call(0, 4), call(200, 5), call(400, 6)],
			source: src_of({ [p]: src })
		});
		const rep = out.find((x) => x.kind === 'repeat-request')!;
		expect(rep).toMatchObject({ save_ms: 30, wait: true });
		expect(rep.sites[0]).toMatchObject({ calls: 3, target: 'GET http://x/api/session?ms=15' });
		expect(rep.sites[0].via?.map((v) => v.line)).toEqual([4, 5, 6]);
		// a write repeated (no `exact`) and the same read on two different pages: no repeat
		expect(
			find_wait_patterns({
				calls: [call(0, 4, { exact: undefined }), call(200, 5, { exact: undefined })]
			}).find((x) => x.kind === 'repeat-request')
		).toBeUndefined();
		expect(
			find_wait_patterns({
				calls: [call(0, 4, { scope: '/a' }), call(200, 5, { scope: '/b' })]
			}).find((x) => x.kind === 'repeat-request')
		).toBeUndefined();
	});
});

describe('waits on the critical path', () => {
	it('a chain saves its sum minus its longest only when nothing as long runs beside it', () => {
		// the chain a → b → c (3 × 50 ms from t 0), and beside it one call of 140 ms
		const nodes = [
			{ label: 'GET x/a', t0: 0, t1: 50, lane: 0, kind: 'net' },
			{ label: 'GET x/b', t0: 50, t1: 100, lane: 0, kind: 'net' },
			{ label: 'GET x/c', t0: 100, t1: 150, lane: 0, kind: 'net' },
			{ label: 'GET y/slow', t0: 0, t1: 140, lane: 1, kind: 'net' }
		];
		const edges = [
			{ from: 'GET x/a', to: 'GET x/b', gap_ms: 0 },
			{ from: 'GET x/b', to: 'GET x/c', gap_ms: 0 }
		];
		const chains = [
			[
				{ start: 1000, ms: 50 },
				{ start: 1050, ms: 50 },
				{ start: 1100, ms: 50 }
			]
		];
		// the simple sum says 100 ms; the slow call beside it keeps the render at 140: only 10 comes off
		expect(wait_save_on_path({ chains }, { nodes, edges }, 150, 1000)).toEqual({
			save_ms: 10,
			bound_by: 'GET y/slow'
		});
		// alone, the whole 100 comes off
		expect(
			wait_save_on_path({ chains }, { nodes: nodes.slice(0, 3), edges }, 150, 1000)
		).toMatchObject({ save_ms: 100 });
		// a call that starts AFTER the chain (the render's own fetch, later) is not beside it: it
		// moves up with the chain, so the whole 100 still comes off
		const later = [
			...nodes.slice(0, 3),
			{ label: 'GET z/later', t0: 160, t1: 190, lane: 0, kind: 'net' }
		];
		expect(wait_save_on_path({ chains }, { nodes: later, edges }, 200, 1000)).toEqual({
			save_ms: 100
		});
		// a chain the graph does not hold: no verdict
		expect(
			wait_save_on_path(
				{
					chains: [
						[
							{ start: 5000, ms: 50 },
							{ start: 5050, ms: 50 }
						]
					]
				},
				{ nodes, edges },
				150,
				1000
			)
		).toBeUndefined();
	});
});

describe('the same answer every render', () => {
	const runs = [
		{ start: 0, end: 100 },
		{ start: 200, end: 300 }
	];
	it('stable_answers: a GET in every run with one body fingerprint; a changed body, a missed run or a write is not', () => {
		const c = (start: number, url: string, hash: string, method = 'GET', status = 200) => ({
			start,
			url,
			method,
			status,
			body_hash: hash
		});
		const s = stable_answers(
			[
				c(10, 'https://a/config', 'x:10'),
				c(210, 'https://a/config', 'x:10'),
				c(20, 'https://a/price', 'p:5'),
				c(220, 'https://a/price', 'q:5'),
				c(30, 'https://a/once', 'o:1'),
				c(40, 'https://a/save', 's:1', 'POST'),
				c(240, 'https://a/save', 's:1', 'POST')
			],
			runs
		);
		expect([...s]).toEqual(['GET https://a/config']);
		expect(stable_answers([c(10, 'https://a/config', 'x:10')], [runs[0]]).size).toBe(0); // one run proves nothing
	});

	it('find_same_answers: one place per kind of request and line, sized, the per-user ones flagged', () => {
		const p = '/app/src/routes/+page.server.ts';
		const at = { path: p, line: 12 };
		const product = (i: number) => ({
			start: 40 + i * 7,
			ms: 6,
			target: 'GET api/product/:id',
			at: { path: p, line: 20 },
			exact: `GET https://api/product/P${i}`,
			bytes: 30
		});
		const calls = [
			{
				start: 0,
				ms: 40,
				target: 'GET api/config',
				at,
				exact: 'GET https://api/config',
				bytes: 4096
			},
			{
				start: 0,
				ms: 30,
				target: 'GET api/session',
				at: { path: p, line: 8 },
				exact: 'GET https://api/session',
				bytes: 200,
				personal: true
			},
			...[0, 1, 2].map(product)
		];
		const stable = new Set(calls.map((c) => c.exact));
		const out = find_same_answers({ calls, stable })!;
		expect(out.kind).toBe('same-answer');
		expect(out.sites.map((s) => [s.target, s.calls])).toEqual([
			['GET https://api/config', 1],
			['GET https://api/session', 1],
			['GET api/product/:id (3 URLs)', 3]
		]);
		expect(out.sites[1].personal).toBe(true);
		expect(out.fix).toContain('1 of these requests carried who is asking');
		expect(out.evidence).toContain(
			'GET https://api/config answered the same 4 KB in every render, 40 ms of waiting each time; 2 more places do the same'
		);
		expect(out.save_ms).toBe(88);
	});
});

describe('fix_impact caps the wait fixes at the render’s waiting', () => {
	it('caching and starting together overlap: together they never take off more than was waited', () => {
		expect(
			fix_impact(
				[
					{ save_ms: 100, wait: true },
					{ save_ms: 90, wait: true }
				],
				400,
				1,
				120
			)
		).toMatchObject({ wait_ms: 120, after_ms: 280 });
	});
});

describe('fix_impact', () => {
	it('adds CPU and waiting savings against the render, capped at 90 %', () => {
		expect(fix_impact([{ save_ms: 200 }, { save_ms: 100, wait: true }], 750)).toEqual({
			cpu_ms: 200,
			wait_ms: 100,
			render_ms: 750,
			after_ms: 450,
			pct: 40
		});
		expect(fix_impact([{ save_ms: 900 }], 750)).toMatchObject({ after_ms: 75, pct: 90 });
		expect(fix_impact([], 750)).toBeUndefined();
		expect(fix_impact([{ save_ms: 10 }], 0)).toBeUndefined();
	});
});

describe('fix_impact units', () => {
	it('CPU savings add up every profiled render, so they are divided per render; waits are one render', () => {
		expect(fix_impact([{ save_ms: 300 }, { save_ms: 100, wait: true }], 750, 3)).toEqual({
			cpu_ms: 100,
			wait_ms: 100,
			render_ms: 750,
			after_ms: 550,
			pct: 27
		});
	});
});

describe('kept-per-render', () => {
	it('lines that leave memory alive after a warm render make one memory card, beside any CPU card for the same line', () => {
		const p = '/app/src/lib/cache.ts';
		const f = fn({ key: 'remember', name: 'remember', path: p, line: 1, calls: 600 });
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 2,
					code: 'seen.set(url, JSON.parse(JSON.stringify(big)));',
					fn: 'remember',
					cpu_ms: 30,
					retained_bytes: 3e6
				}),
				row({
					path: p,
					line: 9,
					code: 'memo.push(entry);',
					fn: 'remember',
					retained_bytes: 200 * 1024
				}),
				// a small keep is noise
				row({ path: p, line: 12, code: 'let x = {};', fn: 'remember', retained_bytes: 4096 })
			],
			functions: [f]
		});
		expect(out.map((x) => x.kind)).toEqual(['deep-copy', 'kept-per-render']);
		const kept = out[1];
		expect(kept.sites.map((s) => s.line)).toEqual([2, 9]);
		expect(kept.kept_bytes).toBe(3e6 + 200 * 1024);
		expect(kept.save_ms).toBe(0);
	});

	it('a line holding a sliver of the total is a passenger: left out of the places, counted in the text', () => {
		const p = '/app/src/lib/ds.ts';
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 17,
					code: 'const r = render(html);',
					retained_bytes: 64 * 1024 * 1024
				}),
				row({
					path: p,
					line: 192,
					code: 'const m = html.match(re);',
					retained_bytes: 3 * 1024 * 1024
				}),
				// page.data made each render, alive because the render's data is
				row({
					path: '/app/src/lib/data.ts',
					line: 102,
					code: 'return { id: path, name };',
					retained_bytes: 192 * 1024
				}),
				row({
					path: '/app/src/lib/md.ts',
					line: 32,
					code: "return s.replace(re, '<$1>');",
					retained_bytes: 131 * 1024
				})
			],
			functions: []
		});
		const kept = out.find((x) => x.kind === 'kept-per-render')!;
		expect(kept.sites.map((s) => s.line)).toEqual([17, 192]);
		expect(kept.title).toContain('(2 places)');
		expect(kept.kept_bytes).toBe((64 + 3) * 1024 * 1024 + (192 + 131) * 1024);
		expect(kept.evidence).toContain('2 smaller lines hold 323 KB more, each under 2% of it');
	});

	it('memory made inside a library the line calls: the card says the library keeps it, and gives its fixes', () => {
		const p = '/app/src/lib/ds.ts';
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 17,
					code: 'const render = (html) => renderLib(html);',
					fn: 'render /app/src/lib/ds.ts',
					retained_bytes: 60 * 1024 * 1024,
					mem_via: 'dslib',
					who: ['renderLib', 'buildAppClosure', '(anonymous)'],
					libs: [{ name: 'renderLib', pkg: 'dslib', ms: 500 }]
				}),
				row({
					path: p,
					line: 192,
					code: 'const m = html.match(re);',
					retained_bytes: 3 * 1024 * 1024
				})
			],
			functions: []
		});
		const kept = out.find((x) => x.kind === 'kept-per-render')!;
		expect(kept.title).toBe('Memory stays alive after every render, inside dslib (2 places)');
		expect(kept.fix).toContain(
			'Your line only calls dslib; what stays alive was made inside it (buildAppClosure)'
		);
		expect(kept.example?.after).toContain('made once, reused');
		// the app's own memory keeps the app advice
		const mine = find_patterns({
			ledger: [row({ path: p, line: 2, code: 'seen.set(k, v);', retained_bytes: 3e6 })],
			functions: []
		});
		expect(mine[0].title).toBe('Memory stays alive after every render');
		expect(mine[0].fix).toMatch(/module-level Map/);
	});

	it('under a quarter megabyte in all is no card', () => {
		const p = '/app/src/lib/cache.ts';
		const out = find_patterns({
			ledger: [row({ path: p, line: 2, code: 'memo.push(entry);', retained_bytes: 130 * 1024 })],
			functions: []
		});
		expect(out).toEqual([]);
	});
});

describe('kept-per-render countdown', () => {
	it('says how many more requests fill the heap at this rate', () => {
		const p = '/app/src/lib/cache.ts';
		const [k] = find_patterns({
			ledger: [
				row({ path: p, line: 2, code: 'seen.set(k, v);', retained_bytes: 64 * 1024 * 1024 })
			],
			functions: [],
			heap: { limit_bytes: 4 * 1024 ** 3, used_bytes: 1024 ** 3 }
		});
		expect(k.requests_left).toBe(48);
		expect(k.evidence).toContain('is full after about 48 more requests');
	});

	it('on a serverless function the ceiling is its memory size, and what happens there is said', () => {
		const p = '/app/src/lib/cache.ts';
		const M = 1024 * 1024;
		const [k] = find_patterns({
			ledger: [row({ path: p, line: 2, code: 'seen.set(k, v);', retained_bytes: 64 * M })],
			functions: [],
			heap: { limit_bytes: 1024 * M, used_bytes: 384 * M, function: true }
		});
		expect(k.requests_left).toBe(10);
		expect(k.evidence).toContain(
			"the function's memory (1.0 GB, 384 MB in use now) runs out after about 10 more requests on one instance"
		);
		expect(k.evidence).toContain('the next one pays a cold start');
		// profiled off the platform, already past the function's size
		const [over] = find_patterns({
			ledger: [row({ path: p, line: 2, code: 'seen.set(k, v);', retained_bytes: 64 * M })],
			functions: [],
			heap: { limit_bytes: 1024 * M, used_bytes: 1200 * M, function: true }
		});
		expect(over.evidence).toContain(
			"this process already uses 1.2 GB, more than the function's 1.0 GB: on the platform this instance would already have been killed"
		);
		expect(over.requests_left).toBeUndefined();
	});
});

describe('heap growth check', () => {
	const M = 1024 * 1024;
	it('a steady climb is a leak; a climb that stops is a bounded cache', () => {
		const leak = heap_growth([100, 164, 228, 292, 356, 420, 484].map((x) => x * M))!;
		expect(leak).toMatchObject({ renders: 6, per_render_bytes: 64 * M, levels_off: false });
		const cache = heap_growth([100, 140, 170, 180, 181, 181, 181].map((x) => x * M))!;
		expect(cache.levels_off).toBe(true);
		expect(heap_growth([100 * M, 101 * M])).toBeUndefined();
	});

	it('flat after three renders: the check may stop (a leak, or a cache still filling, never)', () => {
		const K = 1024;
		// the settled heap barely moves: noise only
		expect(is_flat([100 * M, 100 * M + 40 * K, 100 * M + 10 * K, 100 * M + 60 * K])).toBe(true);
		// 1.2 MB a render (the /inferno plant): not flat
		expect(is_flat([122.8, 124, 125.2, 126.5].map((x) => x * M))).toBe(false);
		// a cache still filling (each reading 200 KB more, over the 256 KB spread): not flat
		expect(is_flat([100 * M, 100 * M + 20 * K, 100 * M + 220 * K, 100 * M + 420 * K].map((x) => x - 400 * K))).toBe(false);
		expect(is_flat([100 * M])).toBe(false);
	});

	it('the memory card says which, and a plateau is neither severe nor counted down', () => {
		const p = '/app/src/lib/cache.ts';
		const ledger = [row({ path: p, line: 2, code: 'seen.set(k, v);', retained_bytes: 60 * M })];
		const heap = { limit_bytes: 4096 * M, used_bytes: 1024 * M };
		const grows = find_patterns({
			ledger,
			functions: [],
			heap,
			growth: heap_growth([100, 164, 228, 292].map((x) => x * M))
		})[0];
		expect(grows).toMatchObject({ growth: 'grows', requests_left: 48 });
		expect(grows.evidence).toContain('Confirmed over 3 more renders');
		const plateau = find_patterns({
			ledger,
			functions: [],
			heap,
			growth: heap_growth([100, 150, 151, 151, 151].map((x) => x * M))
		})[0];
		expect(plateau).toMatchObject({ growth: 'levels-off', title: 'Memory grows, then levels off' });
		expect(plateau.requests_left).toBeUndefined();
		expect(plateau.evidence).toContain('levelled off');
	});
});

describe('seed-whole-read', () => {
	it('points at the line in each island that takes page.data whole, with what the seed ships', () => {
		const p = seed_whole_pattern(
			[
				{
					name: 'PriceTicker',
					file: 'lib/hell/PriceTicker.svelte',
					line: 9,
					code: 'const d = page.data;'
				}
			],
			255 * 1024,
			{ key: 'catalog', bytes: 225 * 1024 }
		)!;
		expect(p).toMatchObject({ kind: 'seed-whole-read', seed_bytes: 255 * 1024, save_ms: 0 });
		expect(p.sites[0]).toMatchObject({
			line: 9,
			code: 'const d = page.data;',
			fn_name: 'PriceTicker'
		});
		expect(p.evidence).toBe(
			'PriceTicker takes page.data whole: the seed ships 255 KB with every page view (the biggest key: catalog, 225 KB)'
		);
		expect(seed_whole_pattern([], 255 * 1024)).toBeUndefined();
		expect(seed_whole_pattern([{ name: 'X', file: 'x', line: 1, code: '' }], 4096)).toBeUndefined();
	});
});

describe('line_deltas', () => {
	const L = (o: Partial<LedgerLine> & Pick<LedgerLine, 'line' | 'code'>): LedgerLine =>
		({
			path: '/a/src/x.ts',
			file: 'src/x.ts',
			cpu_ms: 0,
			lib_ms: 0,
			alloc_bytes: 0,
			gc_ms: 0,
			retained_bytes: 0,
			who: [],
			score: 1,
			...o
		}) as LedgerLine;
	it('matches lines by their code (an edit above moves the number), per render; a changed line is fixed + new', () => {
		const a = [
			L({ line: 62, code: 'html = html.replace(tag, el);', cpu_ms: 180 }),
			L({ line: 33, code: 'return new Intl.NumberFormat(l).format(n);', cpu_ms: 60 }),
			L({ line: 90, code: 'x();', cpu_ms: 6 })
		];
		// b: 3 lines were added above the formatter (33 → 36) and it got cheaper; the replace loop was rewritten
		const b = [
			L({ line: 36, code: 'return new Intl.NumberFormat(l).format(n);', cpu_ms: 9 }),
			L({ line: 64, code: 'html = html.replace(TAGS, (m) => by_tag.get(m));', cpu_ms: 6 }),
			L({ line: 90, code: 'x();', cpu_ms: 6.3 })
		];
		const d = line_deltas(a, b, 3, 3);
		expect(d.map((x) => [x.line, x.status])).toEqual([
			[62, 'fixed'],
			[64, 'new'],
			[36, 'better'],
			[90, 'same']
		]);
		expect(d[0]).toMatchObject({ a_ms: 60, b_ms: 0 });
		expect(d[2]).toMatchObject({ a_ms: 20, b_ms: 3 });
	});
});

describe('rescan needs the rebuilt string', () => {
	it('a short value cleaned per item is not a whole-string rescan; the accumulator scanned then reassigned is', () => {
		const p = '/app/src/lib/util.ts';
		const src = [
			'export function labels(keys) {',
			'\tfor (const key of keys) {',
			"\t\tout.push(humanize(key.replace(/_/g, ' ')));",
			'\t}',
			'}',
			'export function insert(html, styles) {',
			'\tfor (const { style } of styles) {',
			"\t\tconst at = html.indexOf('</head>');",
			'\t\thtml = html.slice(0, at) + style + html.slice(at);',
			'\t}',
			'}'
		].join('\n');
		const f1 = fn({ key: 'labels', name: 'labels', path: p, line: 1 });
		const f2 = fn({ key: 'insert', name: 'insert', path: p, line: 6 });
		const out = find_patterns({
			ledger: [
				row({ path: p, line: 3, code: src.split('\n')[2].trim(), fn: 'labels', cpu_ms: 5 }),
				row({ path: p, line: 8, code: src.split('\n')[7].trim(), fn: 'insert', cpu_ms: 5 })
			],
			functions: [f1, f2],
			source: src_of({ [p]: src })
		});
		expect(out.map((x) => [x.kind, x.sites.map((s) => s.line)])).toEqual([['rescan-in-loop', [8]]]);
	});
});

describe('find_cold_caches', () => {
	const p = '/app/src/lib/catalog.ts';
	const src = [
		'const cache = new WeakMap();', // 1
		'export function toView(p) {', // 2
		'\tconst hit = cache.get(p);', // 3
		'\tif (hit) return hit;', // 4
		'\tconst v = { ...p, score: scoreOf(p) };', // 5
		'\tcache.set(p, v);', // 6
		'\treturn v;', // 7
		'}' // 8
	].join('\n');
	const source = src_of({ [p]: src });
	const f = (calls: number) =>
		fn({
			key: 'toView',
			name: 'toView',
			path: p,
			url: 'src/lib/catalog.ts',
			line: 2,
			calls,
			total_ms: 12
		} as Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path' | 'line'>);
	it('the miss path’s helper ran as often as the memo: the cache never hits', () => {
		const out = find_cold_caches({
			functions: [f(120)],
			call_counts: { 'toView\0file:///c.js': 120, 'scoreOf\0file:///c.js': 120 },
			source
		})!;
		expect(out.title).toBe('A cache never hits');
		expect(out.sites[0]).toMatchObject({ line: 3, calls: 120, hits: 0, target: 'scoreOf' });
	});
	it('a cache that answers most calls, a helper called from elsewhere too, or a cheap memo: quiet', () => {
		expect(
			find_cold_caches({
				functions: [f(120)],
				call_counts: { 'scoreOf\0file:///c.js': 10 },
				source
			})
		).toBeUndefined();
		expect(
			find_cold_caches({
				functions: [f(120)],
				call_counts: { 'scoreOf\0file:///c.js': 300 },
				source
			})
		).toBeUndefined();
		expect(
			find_cold_caches({
				functions: [f(120)],
				call_counts: { 'scoreOf\0file:///a.js': 120, 'scoreOf\0file:///b.js': 120 },
				source
			})
		).toBeUndefined();
		const cheap = { ...f(120), total_ms: 0.2 };
		expect(
			find_cold_caches({
				functions: [cheap],
				call_counts: { 'scoreOf\0file:///c.js': 120 },
				source
			})
		).toBeUndefined();
	});
});

describe('a whole function inlined into a line that runs once', () => {
	it('its cost on the caller line is read inside the callee, whose own loop gives the context', () => {
		const p = '/app/src/routes/+page.server.ts';
		const src = [
			'function attach(products) {', // 1
			'\tconst out = [];', // 2
			'\tfor (const p of products) {', // 3
			'\t\tconst brand = BRANDS.find((b) => b.id === p.brandId);', // 4
			'\t\tout.push({ ...p, brand });', // 5
			'\t}', // 6
			'\treturn out;', // 7
			'}', // 8
			'export async function load() {', // 9
			'\tconst joined = attach(PRODUCTS);', // 10
			'\tconst f = new Intl.NumberFormat("de");', // 11: once, outside any loop — must stay quiet
			'}'
		].join('\n');
		const load = fn({ key: 'load', name: 'load', path: p, line: 9, calls: 1 });
		const out = find_patterns({
			ledger: [
				row({
					path: p,
					line: 10,
					code: 'const joined = attach(PRODUCTS);',
					fn: 'load',
					cpu_ms: 170
				})
			],
			functions: [load],
			source: src_of({ [p]: src })
		});
		expect(out.map((x) => [x.kind, x.sites[0].line, x.sites[0].via?.[0]?.line])).toEqual([
			['lookup-in-loop', 4, 10]
		]);
	});
});

describe('compare: an unchanged render makes CPU moves "shifted"', () => {
	it('within the runs’ spread, fixed/worse CPU rows become shifted; waits and kept memory keep their verdicts', async () => {
		const { mark_shifted } = await import('../src/profiler/compare.js');
		const cmp = {
			render_same: { a_ms: 450, b_ms: 446, noise_ms: 30 },
			patterns: [
				{ kind: 'lookup-in-loop', status: 'fixed' },
				{ kind: 'regexp-per-call', status: 'new' },
				{ kind: 'waits-in-a-row', status: 'better', wait: true },
				{ kind: 'kept-per-render', status: 'worse' },
				{ kind: 'sort-per-call', status: 'same' }
			],
			lines: [
				{ status: 'worse', a_kept: 0, b_kept: 0 },
				{ status: 'new', a_kept: 0, b_kept: 2e6 }
			]
		} as never;
		const out = mark_shifted(cmp) as unknown as {
			patterns: { status: string }[];
			lines: { status: string }[];
		};
		expect(out.patterns.map((p) => p.status)).toEqual([
			'shifted',
			'shifted',
			'better',
			'worse',
			'same'
		]);
		expect(out.lines.map((l) => l.status)).toEqual(['shifted', 'new']);
	});
});

describe('sync I/O too quick to sample, from V8 call counts', () => {
	const page = [
		"import { readFileSync, existsSync } from 'node:fs';",
		"const config = readFileSync('config.json', 'utf8');",
		'if (process.env.X) {',
		"\treadFileSync('startup.txt');",
		'}',
		'/**',
		" * readFileSync('in a comment') is not a call",
		' */',
		'function readManifest() {',
		"\treturn existsSync('m.json') ? readFileSync('m.json', 'utf8').length : 0;",
		'}',
		'function neverCalled() {',
		"\treturn readFileSync('other.json');",
		'}',
		'const rows = items.map((x) => {',
		"\treturn readFileSync(x);",
		'});',
		"export const load = async ({ url }) => ({ size: readManifest(), at: statSync('x') });"
	].join('\n');
	const files = [{ path: '/app/src/routes/p/+page.server.ts', file: 'routes/p/+page.server.ts', text: page }];
	const counts = {
		'readFileSync\0node:fs': 1,
		'existsSync\0node:fs': 1,
		'statSync\0node:fs': 1,
		'readManifest\0file:///app/src/routes/p/+page.server.ts': 1,
		'load\0file:///app/src/routes/p/+page.server.ts': 1
	};
	it('a counted *Sync call inside a function the render ran is a site; start-up code, comments, helpers that never ran are not', () => {
		const p = counted_sync_io(counts, files)!;
		expect(p.kind).toBe('sync-io');
		expect(p.sites.map((s) => [s.line, s.fn_name])).toEqual([
			[10, 'readManifest'],
			[18, 'load']
		]);
		expect(p.evidence).toBe(
			"readFileSync ×1, existsSync ×1, statSync ×1 per render (V8's call counts): too quick for the CPU sampler here, under a millisecond, but each call stops every other request on this server until the disk answers."
		);
	});
	it('no *Sync call counted in Node, or none in the route files: nothing', () => {
		expect(counted_sync_io({ 'readManifest\0file:///x': 1 }, files)).toBeUndefined();
		expect(counted_sync_io(counts, [{ ...files[0], text: 'export const load = () => ({});' }])).toBeUndefined();
	});
});

describe('same_document_pattern: what keeps a shared cache out is named first', () => {
	const base = { file: 'routes/shop/+page.server.ts', render_ms: 40, bytes: 20_000 };
	it('a cookie on the answer', () => {
		const p = same_document_pattern({ ...base, blocked: { cookie: true } });
		expect(p.fix).toContain('First, the response sets a cookie (Set-Cookie)');
		expect(p.fix).toContain('then set Cache-Control with s-maxage');
		expect(p.evidence).toContain('once the response no longer sets a cookie');
	});
	it('private / no-store, and both', () => {
		const p = same_document_pattern({ ...base, blocked: { cookie: true, cache_control: 'private, max-age=0' } });
		expect(p.fix).toContain('sets a cookie (Set-Cookie) and answers Cache-Control: private, max-age=0');
		expect(p.fix).toContain('drop private / no-store');
	});
	it('nothing in the way: the plain advice', () => {
		const p = same_document_pattern(base);
		expect(p.fix).toContain('rendering it. Set Cache-Control with s-maxage');
		expect(p.fix).not.toContain('First,');
	});
});
