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

	it('a module awaits its run; async / nonce / id / data-* become attributes', () => {
		const out = script({ run: async () => {}, type: 'module', async: true, nonce: 'n"1', id: 'x', 'data-k': 3 });
		expect(out.startsWith('<script type="module" async nonce="n&quot;1" id="x" data-k="3">await (async () =>')).toBe(true);
	});

	it('`<!--` in the code is neutralized (it would swallow the page after the tag)', () => {
		const out = script(() => '<!--<script>');
		expect(out).not.toContain('<!--');
		expect(out).toContain('\\x3C!--<script>');
	});

	it('a method in the options object is read back as an expression', () => {
		expect(script({ run() { return 1; } })).toMatch(/^<script>\(Object\.values\(\{run\(\) \{/);
		expect(script({ async run() {} })).toContain('(Object.values({async run()');
		// arrows and function expressions stay as written
		expect(script({ run: (a: number) => a, args: [1] })).toContain('((a) => a)(1)');
		expect(script({ run: function f() {} })).toMatch(/^<script>\(function f\(\)/);
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

	it('imports: static `import * as` first, the namespaces as one object before the args', () => {
		const out = script({ type: 'module', imports: { carousel: '/c.js', 'a-b': 'https://x/<y>.js' }, run: (m, n: number) => [m, n], args: [2] });
		expect(out.startsWith('<script type="module">import * as __og_m0 from "/c.js";import * as __og_m1 from "https://x/\\u003Cy>.js";await (')).toBe(true);
		expect(out.endsWith(')({"carousel":__og_m0,"a-b":__og_m1},2);</script>')).toBe(true);
	});

	it('imports need a module; a bundler-rewritten run is refused with the fix', () => {
		expect(() => script({ run: () => 0, imports: { a: '/a.js' } } as never)).toThrow(/type: 'module'/);
		const rewritten = () => 0;
		rewritten.toString = () => '() => __vite_ssr_dynamic_import__("/a.js")';
		expect(() => script({ run: rewritten, type: 'module' })).toThrow(/imports/);
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
