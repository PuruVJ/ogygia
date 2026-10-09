import { describe, expect, it } from 'vitest';
import type { FrameStat } from '../src/profiler/analyze.js';
import { build_ledger } from '../src/profiler/ledger.js';
import { find_patterns } from '../src/profiler/patterns.js';
import { backtracks, regex_literals } from '../src/profiler/source-scan.js';

// A regular expression slow to RUN: V8 profiles a compiled pattern as its own code (`RegExp: …`),
// charged to the line that runs it, and named for what it is.

const fn = (o: Partial<FrameStat> & Pick<FrameStat, 'key' | 'name' | 'path' | 'line'>): FrameStat =>
	({ url: '', col: 0, category: 'app', self_ms: 0, total_ms: 0, ...o }) as FrameStat;

describe('backtracks', () => {
	it('a repeat inside a repeated group', () => {
		expect(backtracks('^(\\w+\\s?)*$')).toBe(true);
		expect(backtracks('(a+)+b')).toBe(true);
		expect(backtracks('^(?:[a-z]+,?)+$')).toBe(true);
		expect(backtracks('(a{2,})+')).toBe(true);
	});
	it('a fixed part in the group pins where each repeat ends: not claimed', () => {
		expect(backtracks('^\\w+(?:\\s\\w+)*$')).toBe(false);
		expect(backtracks('((ab)*c)+')).toBe(false);
		expect(backtracks('(\\d+-)+')).toBe(false);
	});
	it('one level of repeats, a repeated group of fixed parts, a choice, escapes and classes', () => {
		expect(backtracks('(ab)+')).toBe(false);
		expect(backtracks('(foo|bar)+')).toBe(false);
		expect(backtracks('\\(a+\\)+')).toBe(false);
		expect(backtracks('[(+]+')).toBe(false);
		expect(backtracks('(a{2})+')).toBe(false);
		expect(backtracks(undefined)).toBe(false);
	});
});

describe('regex_literals', () => {
	it('the literals on a line, not a division, a string or a comment', () => {
		expect(regex_literals('return /^([a-z0-9]+-?)*$/.test(s);')).toEqual(['^([a-z0-9]+-?)*$']);
		expect(regex_literals("t.replace(/[/\\]]+/g, '_').split(/,\\s*/)")).toEqual(['[/\\]]+', ',\\s*']);
		expect(regex_literals('const half = total / 2 / count;')).toEqual([]);
		expect(regex_literals('const u = "a/b/c"; // /x+/')).toEqual([]);
		expect(regex_literals('const ok = !/^\\d+$/.test(v) && x;')).toEqual(['^\\d+$']);
	});
});

describe('slow-regex', () => {
	it('no RegExp frame (V8 charged the pattern to the line): a literal that can backtrack still names it', () => {
		const path = '/app/src/lib/slug.ts';
		const src = ['export function isSlug(s: string) {', '\treturn /^([a-z0-9]+-?)*$/.test(s);', '}'];
		const source = (p: string, a: number, b: number) =>
			p === path ? { start: a, lines: src.slice(a - 1, b) } : undefined;
		const functions = [fn({ key: 'isSlug', name: 'isSlug', path, line: 1, calls: 400, lines: [{ line: 2, ms: 75 }] })];
		const ledger = build_ledger({ functions, source, code: (p, l) => source(p, l, l)?.lines[0] });
		const p = find_patterns({ ledger, functions, source, renders: 3 }).find((x) => x.kind === 'slow-regex')!;
		expect(p.title).toBe('A regular expression can backtrack, and runs slowly');
		expect(p.sites[0].line).toBe(2);
	});

	const path = '/app/src/lib/titles.ts';
	const src = [
		'export function valid(titles: string[]) {', // 1
		'\tconst ok = titles.filter((t) => /^(\\w+\\s?)*$/.test(t));', // 2
		'\treturn ok.map((t) => t.replace(/[aeiou]/g, "_"));', // 3
		'}' // 4
	];
	const source = (p: string, a: number, b: number) =>
		p === path ? { start: a, lines: src.slice(a - 1, b) } : undefined;
	const functions = [
		fn({
			key: 'valid',
			name: 'valid',
			path,
			line: 1,
			lines: [{ line: 2, ms: 4 }],
			callees: [
				{ key: 're1', name: 'RegExp: ^(\\w+\\s?)*$', category: 'node', file: '', ms: 60, share: 0.9 },
				{ key: 're2', name: 'RegExp: [aeiou]', category: 'node', file: '', ms: 0.2, share: 0.01 }
			]
		})
	];

	it('the ledger charges a pattern’s own code to the line that writes it', () => {
		const ledger = build_ledger({ functions, source, code: (p, l) => source(p, l, l)?.lines[0] });
		const l2 = ledger.find((l) => l.line === 2)!;
		expect(l2).toMatchObject({ lib_ms: 60, libs: [{ name: 'RegExp: ^(\\w+\\s?)*$', pkg: 'Node', ms: 60 }] });
		expect(ledger.find((l) => l.line === 3)?.lib_ms).toBe(0.2);
	});

	it('names the line, says it can backtrack, and leaves a quick pattern alone', () => {
		const ledger = build_ledger({ functions, source, code: (p, l) => source(p, l, l)?.lines[0] });
		const out = find_patterns({ ledger, functions, source });
		const p = out.find((x) => x.kind === 'slow-regex')!;
		expect(p.title).toBe('A regular expression can backtrack, and runs slowly');
		expect(p.sites.map((s) => s.line)).toEqual([2]);
		expect(p.save_ms).toBeCloseTo(64 * 0.8, 1);
	});

	it('a short value cleaned per item is not "the whole string rescanned", however much it adds up to', () => {
		const p3 = '/app/src/lib/names.ts';
		const s3 = ["export const initials = (names: string[]) => names.map((n) => n.replace(/\\b(\\w)\\w*/g, '$1'));"];
		const source3 = (p: string, a: number, b: number) =>
			p === p3 ? { start: a, lines: s3.slice(a - 1, b) } : undefined;
		const row = {
			path: p3,
			file: 'lib/names.ts',
			line: 1,
			code: s3[0],
			cpu_ms: 3,
			alloc_bytes: 1.5 * 1024 * 1024,
			gc_ms: 0,
			retained_bytes: 0,
			lib_ms: 0,
			who: [],
			score: 1,
			fn: 'arrow'
		};
		const run = (calls?: number, alloc = row.alloc_bytes) =>
			find_patterns({
				ledger: [{ ...row, alloc_bytes: alloc }] as never,
				functions: [fn({ key: 'arrow', name: '(anonymous)', path: p3, line: 1, ...(calls ? { calls } : {}) })],
				source: source3,
				renders: 1
			}).some((x) => x.kind === 'rescan-in-loop');
		// the callback ran 3 000 times: 500 bytes each
		expect(run(3000)).toBe(false);
		// no count to divide by: 1.5 MB a render could be a pile of small strings (quiet); 5 MB is not
		expect(run()).toBe(false);
		expect(run(undefined, 5 * 1024 * 1024)).toBe(true);
	});

	it('read into an inlined callee, the caller\'s one call is not the callee\'s: its bytes are every item\'s', () => {
		const page = '/app/src/routes/+page.server.ts';
		const lib = '/app/src/lib/names.ts';
		const files: Record<string, string[]> = {
			[page]: ["import { initials } from '$lib/names';", 'export async function load() {', '\tconst inits = sorted.map((p) => initials(p.name));', '}'],
			[lib]: ['export function initials(name: string) {', "\treturn name.replace(/\\b(\\w)\\w*/g, '$1');", '}']
		};
		const source = (p: string, a: number, b: number) => (files[p] ? { start: a, lines: files[p].slice(a - 1, b) } : undefined);
		// V8 inlined `initials`: its cost sits on the caller's line, whose function ran once
		const run = (alloc: number) =>
			find_patterns({
				ledger: [
					{ path: page, file: 'routes/+page.server.ts', line: 3, code: files[page][2], cpu_ms: 3, alloc_bytes: alloc, gc_ms: 0, retained_bytes: 0, lib_ms: 0, who: [], score: 1, fn: 'load' }
				] as never,
				functions: [
					fn({ key: 'load', name: 'load', path: page, line: 2, calls: 1 }),
					fn({ key: 'initials', name: 'initials', path: lib, line: 1 })
				],
				source,
				renders: 1
			}).some((x) => x.kind === 'rescan-in-loop');
		expect(run(1.6 * 1024 * 1024)).toBe(false);
		expect(run(5 * 1024 * 1024)).toBe(true);
	});

	it('a cheap pattern run thousands of times stays quiet: no rewrite of it helps', () => {
		const p2 = '/app/src/lib/names.ts';
		const s2 = [
			'export const vowels = (t: string) => t.replace(/[aeiou]/g, "_");' // 1
		];
		const source2 = (p: string, a: number, b: number) =>
			p === p2 ? { start: a, lines: s2.slice(a - 1, b) } : undefined;
		const f2 = [
			fn({
				key: 'vowels',
				name: 'vowels',
				path: p2,
				line: 1,
				calls: 10_000,
				lines: [{ line: 1, ms: 2 }],
				callees: [{ key: 're', name: 'RegExp: [aeiou]', category: 'node', file: '', ms: 8, share: 0.8 }]
			})
		];
		const ledger = build_ledger({ functions: f2, source: source2, code: (p, l) => source2(p, l, l)?.lines[0] });
		expect(ledger[0].lib_ms).toBe(8);
		const out = find_patterns({ ledger, functions: f2, source: source2, renders: 1 });
		expect(out.some((x) => x.kind === 'slow-regex')).toBe(false);
	});
});
