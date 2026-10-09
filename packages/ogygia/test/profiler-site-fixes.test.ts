import { describe, expect, it } from 'vitest';
import { site_fixes } from '../src/profiler/site-fixes.js';
import type { Pattern } from '../src/profiler/patterns.js';

// A slow line in a shared helper, added up over every page whose latest report names it.

const pat = (
	kind: string,
	save_ms: number,
	sites: { file: string; line: number; cpu_ms?: number; wait_ms?: number; module?: string }[],
	extra: Partial<Pattern> = {}
): Pattern =>
	({
		kind,
		title: `${kind} (${sites.length} places)`,
		save_ms,
		cost_ms: save_ms,
		alloc_bytes: 0,
		fix: '',
		evidence: '',
		sites: sites.map((s) => ({ path: s.file, code: 'x', cpu_ms: 0, ...s })),
		...extra
	}) as unknown as Pattern;

describe('site_fixes', () => {
	it('a line two pages share, its saving per page (by the site share) and in all; one-page lines left to their report', () => {
		const fmt = { file: 'lib/format.ts', line: 6, cpu_ms: 30 };
		const out = site_fixes([
			// 3 runs: CPU savings add up over them
			{
				id: 'a',
				page: '/search',
				created: 2,
				runs: 3,
				patterns: [
					pat('formatter-per-call', 90, [fmt, { file: 'lib/other.ts', line: 1, cpu_ms: 30 }])
				]
			},
			{
				id: 'b',
				page: '/deals',
				created: 3,
				runs: 2,
				patterns: [
					pat('formatter-per-call', 20, [fmt]),
					pat('scan-for-key', 8, [{ file: 'lib/i18n.ts', line: 33, cpu_ms: 4 }])
				]
			},
			// an older report of /search: the latest one speaks for the page
			{
				id: 'old',
				page: '/search',
				created: 1,
				runs: 1,
				patterns: [pat('formatter-per-call', 500, [fmt])]
			}
		]);
		expect(out).toEqual([
			{
				kind: 'formatter-per-call',
				title: 'formatter-per-call',
				where: 'lib/format.ts',
				line: 6,
				code: 'x',
				// /search: 90/3 = 30 a render, half of it on this line; /deals: 20/2 = 10
				pages: [
					{ page: '/search', ms: 15, report: 'a' },
					{ page: '/deals', ms: 10, report: 'b' }
				],
				total_ms: 25
			}
		]);
	});

	it('keeping answers or the whole page is a per-page decision; memory is not a time; a built line goes by its module', () => {
		const s = { file: 'chunks/format.js', line: 131, cpu_ms: 5, module: 'src/lib/format.ts' };
		const out = site_fixes([
			{
				id: 'a',
				page: '/a',
				created: 1,
				runs: 1,
				patterns: [
					pat('same-answer', 50, [{ file: 'r.ts', line: 3, wait_ms: 50 }], { wait: true }),
					pat('date-parse', 6, [s])
				]
			},
			{
				id: 'b',
				page: '/b',
				created: 1,
				runs: 1,
				patterns: [
					pat('same-answer', 50, [{ file: 'r.ts', line: 3, wait_ms: 50 }], { wait: true }),
					pat('date-parse', 4, [s]),
					pat('kept-per-render', 0, [s], { kept_bytes: 1e7 })
				]
			}
		]);
		expect(out.map((f) => [f.kind, f.where, f.total_ms])).toEqual([
			['date-parse', 'src/lib/format.ts', 10]
		]);
	});
});
