import { describe, it, expect } from 'vitest';
import { tokenize, html_diff } from '../src/devtools/html-diff.js';

describe('tokenize', () => {
	it('tags and text, comments out, whitespace folded', () => {
		expect(tokenize('<!--[--><p class="a">hello   \n world</p><!--]-->')).toEqual(['<p class="a">', 'hello world', '</p>']);
	});
});

describe('html_diff', () => {
	it('names exactly what changed, with context', () => {
		const d = html_diff('<ul><li>a</li><li>b</li><li>c</li></ul><p>rendered on the server</p>', '<!--[--><ul><li>a</li><li>b</li><li>c</li></ul><p>rendered on the browser</p>');
		expect(d.removed).toBe(1);
		expect(d.added).toBe(1);
		const ops = d.hunks.flatMap((h) => h.ops);
		expect(ops.find((o) => o.op === 'del')?.text).toBe('rendered on the server');
		expect(ops.find((o) => o.op === 'add')?.text).toBe('rendered on the browser');
		expect(ops.some((o) => o.op === 'same' && o.text === '<p>')).toBe(true); // context kept
	});

	it('an added attribute and an extra element', () => {
		const d = html_diff('<div><span>x</span></div>', '<div data-x="1"><span>x</span><b>new</b></div>');
		const ops = d.hunks.flatMap((h) => h.ops);
		expect(ops.filter((o) => o.op === 'add').map((o) => o.text)).toEqual(['<div data-x="1">', '<b>', 'new', '</b>']);
		expect(ops.filter((o) => o.op === 'del').map((o) => o.text)).toEqual(['<div>']);
	});

	it('identical markup (comments aside) has no hunks', () => {
		expect(html_diff('<!--[0--><p>x</p>', '<!--[--><!--[0--><p>x</p><!--]-->').hunks).toEqual([]);
	});

	it('gives up gracefully on a huge rewrite', () => {
		const a = Array.from({ length: 2000 }, (_, i) => `<i>${i}</i>`).join('');
		const b = Array.from({ length: 2000 }, (_, i) => `<b>${i}</b>`).join('');
		const d = html_diff(a, b, 3, 100);
		expect(d.partial).toBe(true);
		expect(d.hunks.length).toBeGreaterThan(0);
	});
});
