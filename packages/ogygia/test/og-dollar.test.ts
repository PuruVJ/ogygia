/**
 * `import.meta.og.$` — the fn-hoist construct. Transform-level tests: detection, capture
 * analysis (free names → bound params, globals pass), the __og_$ rewrite, manifest hoists,
 * and the strict-position build errors.
 */
import { describe, it, expect } from 'vitest';
import { rewrite_dollar } from '../src/vite/og-dollar.js';
import { __register_fn, fn_handle } from '../src/fn-transport.js';

const SVELTE = ['.svelte'];
const run = (src: string, id = 'src/routes/x.ts') => rewrite_dollar(src, id, id, SVELTE);

describe('og.$ transform', () => {
	it('rewrites the mark to __og_$(tag, [captures], factory) and injects the import', () => {
		const src = `const tax = 0.19;\nexport const fmt = import.meta.og.$((n) => n * (1 + tax));`;
		const { code, hoists } = run(src);
		expect(code).toContain(`import { __og_$ } from 'ogygia/internal';`);
		expect(code).toContain(`__og_$("src/routes/x.ts#$0", [tax], (tax) => ((n) => n * (1 + tax)))`);
		expect(hoists).toHaveLength(1);
		expect(hoists[0].tag).toBe('src/routes/x.ts#$0');
		expect(hoists[0].factory_src).toBe('(tax) => ((n) => n * (1 + tax))');
	});

	it('captures: locals bind; params/inner declarations/globals do not', () => {
		const src = `const a = 1; const b = 2;\nconst f = import.meta.og.$((x) => { const c = a + x; return Math.max(c, b, JSON.parse('3')); });`;
		const { hoists } = run(src);
		expect(hoists[0].factory_src.startsWith('(a, b) =>')).toBe(true); // x, c, Math, JSON excluded
	});

	it('member properties and object keys are not captures', () => {
		const src = `const obj = { deep: 1 };\nconst f = import.meta.og.$(() => ({ made: obj.deep, obj: 1 }));`;
		const { hoists } = run(src);
		expect(hoists[0].factory_src.startsWith('(obj) =>')).toBe(true); // only `obj`; `.deep`/keys excluded
	});

	it('a capture-free fn hoists with empty params', () => {
		const { code, hoists } = run(`const f = import.meta.og.$(() => 42);`);
		expect(hoists[0].factory_src).toBe('() => (() => 42)');
		expect(code).toContain(`[], () => (() => 42)`);
	});

	it('multiple marks in one module get sequential tags', () => {
		const src = `const f = import.meta.og.$(() => 1);\nconst g = import.meta.og.$(() => 2);`;
		const { hoists } = run(src);
		expect(hoists.map((h) => h.tag)).toEqual(['src/routes/x.ts#$0', 'src/routes/x.ts#$1']);
	});

	it('works inside a .svelte script block', () => {
		const src = `<script>\n\tconst site = 'x';\n\tconst track = import.meta.og.$((e) => [site, e]);\n</script>\n<button onclick={() => track('hi')}>go</button>`;
		const { code, hoists } = rewrite_dollar(src, 'src/routes/+layout.svelte', 'src/routes/+layout.svelte', SVELTE);
		expect(hoists[0].tag).toBe('src/routes/+layout.svelte#$0');
		expect(code).toContain('__og_$(');
	});

	it('no marker → same reference back, zero hoists', () => {
		const src = `export const x = 1;`;
		const res = run(src);
		expect(res.code).toBe(src);
		expect(res.hoists).toEqual([]);
	});

	it('BUILD ERROR: zero or two arguments', () => {
		expect(() => run(`const f = import.meta.og.$();`)).toThrow(/exactly one argument/);
		expect(() => run(`const f = import.meta.og.$(() => 1, 2);`)).toThrow(/exactly one argument/);
	});

	it('a non-function argument is a BOUNDARY ASSERTION, not an error (universal mark)', () => {
		const { code } = run(`const f = import.meta.og.$(someFn);`);
		expect(code).toContain(`__og_boundary((someFn), "src/routes/x.ts:1")`);
	});

	it('BUILD ERROR: bare access / aliasing', () => {
		expect(() => run(`const alias = import.meta.og.$;`)).toThrow(/bare import.meta.og.\$/);
	});

	it('marker inside a string is never rewritten', () => {
		const src = `const s = "import.meta.og.$(() => 1)";`;
		// parses fine; the AST sees a string literal, not a call — untouched
		const res = run(src);
		expect(res.code).toBe(src);
	});
});

describe('og.$ end-to-end (transform output executed against the real runtime)', () => {
	it('the rewritten expression returns a live, correctly-bound function', () => {
		const src = `const tax = 0.19;\nglobalThis.__dollar_out = import.meta.og.$((n) => Math.round(n * (1 + tax)));`;
		const { code } = run(src, 'src/lib/pricing.ts');
		// execute the transformed module body with the real runtime in scope
		const body = code.replace(`import { __og_$ } from 'ogygia/internal';`, '');
		new Function('__og_$', body)((tag: string, bound: unknown[], factory: (...b: unknown[]) => unknown) => {
			__register_fn(tag, factory);
			return fn_handle(tag, bound);
		});
		const live = (globalThis as Record<string, unknown>).__dollar_out as (n: number) => number;
		expect(live(100)).toBe(119);
		delete (globalThis as Record<string, unknown>).__dollar_out;
	});
});

describe('og.$ server-only capture rejection', () => {
	it('BUILD ERROR: capturing a $env/static/private import', () => {
		const src = `import { API_KEY } from '$env/static/private';\nconst f = import.meta.og.$(() => fetch('/x?k=' + API_KEY));`;
		expect(() => run(src)).toThrow(/captures `API_KEY` from the server-only module/);
	});

	it('BUILD ERROR: capturing from a .server module or $app/server', () => {
		const a = `import { db } from '$lib/db.server.js';\nconst f = import.meta.og.$(() => db);`;
		expect(() => run(a)).toThrow(/server-only module '\$lib\/db\.server\.js'/);
		const b = `import { read } from '$app/server';\nconst f = import.meta.og.$(() => read);`;
		expect(() => run(b)).toThrow(/server-only module '\$app\/server'/);
	});

	it('public env and normal imports still capture fine', () => {
		const src = `import { PUB } from '$env/static/public';\nconst f = import.meta.og.$(() => PUB);`;
		expect(run(src).hoists).toHaveLength(1);
	});
});

describe('og.$ as the UNIVERSAL boundary mark (non-function values)', () => {
	it('a non-function value rewrites to a boundary assertion at the marked site', () => {
		const src = `const store = makeStore();\nconst v = import.meta.og.$(store);`;
		const { code } = run(src);
		expect(code).toContain(`__og_boundary((store), "src/routes/x.ts:2")`);
		expect(code).toContain(`import { __og_boundary } from 'ogygia/internal';`);
	});

	it('mixed fn + value marks in one module import both runtimes', () => {
		const src = `const a = import.meta.og.$(() => 1);\nconst b = import.meta.og.$({ x: 1 });`;
		const { code } = run(src);
		expect(code).toContain(`import { __og_$, __og_boundary } from 'ogygia/internal';`);
	});
});

describe('og.$ in TEMPLATE expressions (props in markup)', () => {
	it('an inline fn prop hoists with captures from the component scope', () => {
		const src = `<script>\n\tconst rate = 2;\n</script>\n<Island fmt={import.meta.og.$((n) => n * rate)} />`;
		const { code, hoists } = rewrite_dollar(src, 'src/routes/p.svelte', 'src/routes/p.svelte', SVELTE);
		expect(code).toContain(`fmt={__og_$("src/routes/p.svelte#$0", [rate], (rate) => ((n) => n * rate))}`);
		expect(code).toContain(`import { __og_$ } from 'ogygia/internal';`);
		expect(hoists).toHaveLength(1);
	});

	it('a value prop becomes a boundary assertion; imports merge with script-pass injection', () => {
		const src = `<script>\n\tconst s = makeStore();\n\tconst f = import.meta.og.$(() => 1);\n</script>\n<Island store={import.meta.og.$(s)} />`;
		const { code } = rewrite_dollar(src, 'src/routes/p.svelte', 'src/routes/p.svelte', SVELTE);
		expect(code).toContain(`store={__og_boundary((s), "src/routes/p.svelte:5")}`);
		expect(code).toContain(`import { __og_$, __og_boundary } from 'ogygia/internal';`);
	});
});
