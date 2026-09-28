import { describe, expect, it } from 'vitest';
import { matchable, split_selectors, styles_findings, type StylesReport } from '../src/devtools/styles.js';
import { find_unscoped, unscoped_finding, unscoped_marker } from '../src/unscoped-css.js';
import { weigh_assets } from '../src/profiler/page-assets.js';

describe('the unscoped-fallback marker', () => {
	it('carries the file name only and the reason, and reads back', () => {
		const m = unscoped_marker('/home/ci/app/src/lib/Card.svelte', 'Unexpected token');
		expect(m).toBe('/*! ogygia-unscoped: Card.svelte | Unexpected token */\n');
		expect(find_unscoped(m + '.row{color:red}')).toEqual([{ file: 'Card.svelte', why: 'Unexpected token' }]);
	});
	it('a reason that would close the comment cannot', () => {
		const m = unscoped_marker('C:\\app\\X.svelte', 'bad */ .evil{}\nline two');
		expect(m.indexOf('*/')).toBe(m.length - 3);
		expect(find_unscoped(m)[0].file).toBe('X.svelte');
	});
	it('each file once, however many sheets repeat it', () => {
		const css = unscoped_marker('/a/A.svelte', 'x') + unscoped_marker('/a/B.svelte', 'y') + unscoped_marker('/a/A.svelte', 'x');
		expect(find_unscoped(css).map((u) => u.file)).toEqual(['A.svelte', 'B.svelte']);
	});
	it('the finding names them and the way to the full reason', () => {
		const f = unscoped_finding([{ file: 'Card.svelte', why: 'Unexpected token' }]);
		expect(f.code).toBe('css-unscoped');
		expect(f.message).toContain('Card.svelte (Unexpected token)');
		expect(f.fix).toContain('scoped CSS for');
	});
});

describe('selectors, ready to try against the page', () => {
	it('splits on top-level commas only', () => {
		expect(split_selectors('.a, :is(.b, .c) > .d,[data-x="1,2"]')).toEqual(['.a', ':is(.b, .c) > .d', '[data-x="1,2"]']);
	});
	it('takes off pseudo-elements and momentary states, keeps real pseudo-classes', () => {
		expect(matchable('.btn:hover')).toBe('.btn');
		expect(matchable('a:focus-visible > span::before')).toBe('a > span');
		expect(matchable('.x::part(label)')).toBe('.x');
		expect(matchable('input:checked + label')).toBe('input:checked + label');
		expect(matchable('li:first-child:hover')).toBe('li:first-child');
		// `:focus` never eats the start of `:focus-within`
		expect(matchable('.f:focus-within')).toBe('.f');
		expect(matchable('::selection')).toBe('');
		expect(matchable('nav > :hover')).toBe('nav');
	});
});

describe('styles findings', () => {
	const base: StylesReport = { sheets: [], rules: 0, bytes: 0, unmatched: 0, unmatched_bytes: 0, examples: [], unscoped: [], unreadable: 0 };
	it('says nothing about a small or mostly used sheet', () => {
		expect(styles_findings({ ...base, rules: 100, unmatched: 90, unmatched_bytes: 5000 })).toEqual([]);
		expect(styles_findings({ ...base, rules: 1000, unmatched: 300, unmatched_bytes: 60000 })).toEqual([]);
	});
	it('names the sheets that hold the unmatched rules', () => {
		const sheets = [
			{ label: 'big.css', href: '/big.css', rules: 600, bytes: 60000, blocking: true, unmatched: 600, unmatched_bytes: 59000, ogygia: false },
			{ label: 'app.css', href: '/app.css', rules: 10, bytes: 800, blocking: true, unmatched: 1, unmatched_bytes: 40, ogygia: false }
		];
		const f = styles_findings({ ...base, sheets, rules: 610, unmatched: 601, unmatched_bytes: 59040 });
		expect(f.map((x) => x.code)).toEqual(['css-unmatched']);
		expect(f[0].message).toContain('98%');
		expect(f[0].message).toContain('big.css 600 rules');
	});
	it('an unscoped component is a warning, first', () => {
		const f = styles_findings({ ...base, unscoped: [{ file: 'Card.svelte', why: 'x', sheet: 'a.css' }] });
		expect(f[0]).toMatchObject({ code: 'css-unscoped', severity: 'warn' });
	});
});

describe('the profiler finds the marker in the files it weighs', () => {
	const css_with = unscoped_marker('/src/lib/Card.svelte', 'Unexpected token') + '.row{color:red}';
	const fetch_url = async (u: string) => new Response(u.endsWith('a.css') ? css_with : '.ok{}', { headers: { 'content-type': 'text/css' } });
	it('in a linked stylesheet', async () => {
		const pa = await weigh_assets({ page_url: 'http://x.test/', fetch_url, cache: new Map(), html: '<html><head><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"></head><body></body></html>' });
		expect(pa.unscoped).toEqual([{ file: 'Card.svelte', why: 'Unexpected token', in: 'http://x.test/a.css' }]);
	});
	it('in an inline <style>, but not in page text that quotes it', async () => {
		const html = `<html><head><style>${css_with}</style></head><body><pre>/*! ogygia-unscoped: Quoted.svelte | x */</pre></body></html>`;
		const pa = await weigh_assets({ page_url: 'http://x.test/', fetch_url, cache: new Map(), html });
		expect(pa.unscoped?.map((u) => u.file)).toEqual(['Card.svelte']);
	});
	it('nothing marked, nothing said', async () => {
		const pa = await weigh_assets({ page_url: 'http://x.test/', fetch_url, cache: new Map(), html: '<link rel="stylesheet" href="/b.css">' });
		expect(pa.unscoped).toBeUndefined();
	});
});
