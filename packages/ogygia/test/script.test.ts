// `script()`: one object shape (a payload key + the tag's attributes), a bare function as the
// shortcut. Runtime output, escaping, and the type-level refusals.
import { describe, expect, it } from 'vitest';
import { script } from '../src/script.ts';

describe('script()', () => {
	it('a bare function is a classic inline script', () => {
		expect(script(() => 1)).toBe('<script>(() => 1)();</script>');
	});

	it('the shortcut takes trailing args, same as `{ run, args }`', () => {
		const run = (k: string, n: number) => k + n;
		expect(script(run, 'og-theme', 2)).toBe(script({ run, args: ['og-theme', 2] }));
		expect(script(run, 'og-theme', 2).endsWith('("og-theme",2);</script>')).toBe(true);
	});

	it('args are JSON, `<` escaped, `undefined` positional', () => {
		const out = script({ run: (a: string, b: undefined, c: number) => a + b + c, args: ['</script><b>', undefined, 2] });
		expect(out.endsWith(')("\\u003C/script>\\u003Cb>",undefined,2);</script>')).toBe(true);
	});

	it('`</script` in the code cannot close the tag', () => {
		const out = script(() => '</SCRIPT>');
		expect(out).toContain('<\\/SCRIPT>');
		expect(out.toLowerCase().indexOf('</script>')).toBe(out.length - 9);
	});

	it('a module awaits its run; async / blocking / nonce / id / data-* become attributes', () => {
		const out = script({ run: async () => {}, type: 'module', async: true, blocking: 'render', nonce: 'n"1', id: 'x', 'data-k': 3 });
		expect(out.startsWith('<script type="module" async blocking="render" nonce="n&quot;1" id="x" data-k="3">await (async () =>')).toBe(true);
	});

	it('false / null / undefined attributes are left out; `nomodule` is bare', () => {
		expect(script({ run: () => 0, nomodule: true, id: undefined, 'data-a': false, 'data-b': null })).toBe('<script nomodule>(() => 0)();</script>');
	});

	it('data payloads: their type, JSON with `<` escaped', () => {
		expect(script({ json: { a: '</script>' }, id: 'cfg' })).toBe('<script type="application/json" id="cfg">{"a":"\\u003C/script>"}</script>');
		expect(script({ ld: { '@type': 'Article' } })).toBe('<script type="application/ld+json">{"@type":"Article"}</script>');
		expect(script({ importmap: { imports: { a: '/a.js' } } })).toBe('<script type="importmap">{"imports":{"a":"/a.js"}}</script>');
		expect(script({ speculation: { prerender: [{ where: { href_matches: '/*' } }] } })).toBe(
			'<script type="speculationrules">{"prerender":[{"where":{"href_matches":"/*"}}]}</script>'
		);
	});

	it('spreads', () => {
		const base = { type: 'module', nonce: 'abc' } as const;
		expect(script({ ...base, run: () => 0 })).toBe('<script type="module" nonce="abc">await (() => 0)();</script>');
	});

	it('refuses no payload, two payloads, and a bad attribute name', () => {
		expect(() => script({} as never)).toThrow(/exactly one/);
		expect(() => script({ json: 1, ld: 2 } as never)).toThrow(/exactly one/);
		expect(() => script({ run: () => 0, 'data-x" onload="y': 1 } as never)).toThrow(/attribute name/);
	});
});
