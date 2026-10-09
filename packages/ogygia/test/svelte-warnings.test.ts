// Svelte's dev hydration warnings, read off the console line: the code, the message, the file
// (without the zero-width spaces Svelte breaks paths with), and nothing for other warnings.
import { expect, test } from 'vitest';
import { parse_svelte_warning } from '../src/runtime/svelte-warnings.js';
import { analyze_page } from '../src/devtools/page-insights.js';

const line =
	'%c[svelte] hydration_html_changed\n%cThe value of an `{@html ...}` block in /​Users/​me/​app/​src/​Card.svelte changed between server and client renders. The client value will be ignored in favour of the server value\nhttps://svelte.dev/e/hydration_html_changed';

test('a hydration warning: code, message, the component file', () => {
	const w = parse_svelte_warning(line)!;
	expect(w.code).toBe('hydration_html_changed');
	expect(w.file).toBe('/Users/me/app/src/Card.svelte');
	expect(w.message.startsWith('The value of an `{@html ...}` block')).toBe(true);
	expect(w.message).not.toContain('https://svelte.dev');
});

test('not a hydration warning: nothing', () => {
	expect(parse_svelte_warning('%c[svelte] state_snapshot_uncloneable\n%cValue cannot be cloned')).toBeNull();
	expect(parse_svelte_warning('some other warning')).toBeNull();
});

test('the finding groups them and names the island when it knows it', () => {
	const r = analyze_page(
		{
			vitals: {},
			visit: { warnings: [{ code: 'hydration_html_changed', message: 'x', file: '/a/Card.svelte', fp: 'aaaaaaaa11111111' }, { code: 'hydration_html_changed', message: 'x', file: '/a/Card.svelte', fp: 'aaaaaaaa11111111' }] },
			islands: [],
			firsts: [],
			shifts: [],
			longtasks: []
		},
		[{ fp: 'aaaaaaaa11111111', name: 'Card', kind: 'island', wake: 'load', hydrated: true }]
	);
	const f = r.findings.find((x) => x.code === 'svelte-hydration-warning')!;
	expect(f.message).toContain('hydration_html_changed in Card.svelte (Card) ×2');
	expect(f.fps).toEqual(['aaaaaaaa11111111']);
});
