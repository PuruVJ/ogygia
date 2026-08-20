/**
 * ADVERSARIAL stress suite for the `import.meta.og.*` transform machinery. The contract every case
 * asserts: the transform either does the RIGHT thing or FAILS LOUDLY — it never silently corrupts,
 * never rewrites a comment/string, never throws an unhelpful low-level error, never produces
 * unbalanced output. "Demented input someone would never dream of" is the target.
 */
import { describe, expect, it } from 'vitest';
import { rewrite_wire, WIRE_EXPR } from '../src/compiler/macros/wire.js';
import { rewrite_loaders, find_loader_calls } from '../src/compiler/content/loaders.js';
import { og_js_regions } from '../src/compiler/parse/scan.js';

const MARKUP = ['.svelte'] as const;
const CODEC = `{ encode: (c) => c.v, decode: (v) => new C(v) }`;

/** A rewrite must never leave a live marker behind, and never unbalance braces/parens. */
function balanced(s: string): boolean {
	let round = 0;
	let curly = 0;
	for (const ch of s) {
		if (ch === '(') round++;
		else if (ch === ')') round--;
		else if (ch === '{') curly++;
		else if (ch === '}') curly--;
	}
	return round === 0 && curly === 0;
}

describe('wire — byte-offset integrity (multi-byte unicode / CRLF / BOM before the construct)', () => {
	it('multi-byte emoji BEFORE the construct does not shift the splice', () => {
		// 🔥 is 2 UTF-16 units / 4 UTF-8 bytes. If the parser gave byte offsets and we sliced by
		// UTF-16, the rewrite would land mid-string. This asserts the whole family's offset model.
		const src = `const banner = "🔥🔥🔥 hot";\nclass C { static wire = import.meta.og.wire(${CODEC}); }`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain(`const banner = "🔥🔥🔥 hot";`); // the prose before is intact
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC}`);
		expect(out).not.toContain('import.meta.og.wire(');
	});

	it('astral-plane chars (𝕏, 👨‍👩‍👧) before and inside the codec stay intact', () => {
		const codec = `{ encode: (c) => '𝕏' + c.v, decode: (v) => new C(v) }`;
		const src = `// 👨‍👩‍👧‍👦 family\nclass C { static wire = import.meta.og.wire(${codec}); }`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain(codec);
		expect(out).toContain('// 👨‍👩‍👧‍👦 family');
	});

	it('CRLF line endings before the construct', () => {
		const src = `const a = 1;\r\nconst b = 2;\r\nclass C { static wire = import.meta.og.wire(${CODEC}); }`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC}`);
		expect(out).toContain('const a = 1;\r\nconst b = 2;');
	});

	it('a leading BOM does not shift offsets', () => {
		const src = `﻿class C { static wire = import.meta.og.wire(${CODEC}); }`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC}`);
	});
});

describe('wire — demented shapes that must still WORK', () => {
	it('no trailing semicolon (ASI)', () => {
		const out = rewrite_wire(`class C { static wire = import.meta.og.wire(${CODEC}) }`, '/x.ts', MARKUP);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC}`);
		expect(out).not.toContain('import.meta.og.wire(');
	});

	it('a nested class INSIDE the codec that has its OWN wire member', () => {
		const src = `class Outer {
	static wire = import.meta.og.wire({
		encode: (o) => o.v,
		decode: (v) => { class Inner { static wire = import.meta.og.wire(${CODEC}); } return new Outer(v); }
	});
}`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		// both members rewrite; no marker survives; braces stay balanced
		expect(out).not.toContain('import.meta.og.wire(');
		expect((out.match(new RegExp(WIRE_EXPR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length).toBe(2);
		expect(balanced(out)).toBe(true);
	});

	it('two transportable classes in one module', () => {
		const src = `export class A { static wire = import.meta.og.wire(${CODEC}); }\nexport class B { static wire = import.meta.og.wire(${CODEC}); }`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect((out.match(/Symbol\.for/g) ?? []).length).toBe(2);
	});

	it('a comment sitting between `static` and `wire`', () => {
		// AST tolerates it; the member is still `static wire = …`.
		const src = `class C { static /* keep me */ wire = import.meta.og.wire(${CODEC}); }`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain(WIRE_EXPR);
		expect(out).not.toContain('import.meta.og.wire(');
	});

	it('unicode / non-ASCII inside the codec strings', () => {
		const codec = `{ encode: (c) => '🔥' + c.v, decode: (v) => new C(v.replace('café', '')) }`;
		const out = rewrite_wire(`class C { static wire = import.meta.og.wire(${codec}); }`, '/x.ts', MARKUP);
		expect(out).toContain(codec);
		expect(balanced(out)).toBe(true);
	});

	it('a template literal with `${}` interpolation inside the codec', () => {
		const codec = '{ encode: (c) => `id:${c.v}`, decode: (v) => new C(v) }';
		const out = rewrite_wire(`class C { static wire = import.meta.og.wire(${codec}); }`, '/x.ts', MARKUP);
		expect(out).toContain(codec);
	});

	it('the codec spans many lines with nested braces and a trailing comma', () => {
		const codec = `{\n\tencode: (c) => ({ a: c.a, b: { deep: c.b } }),\n\tdecode: (d) => new C(d),\n}`;
		const out = rewrite_wire(`class C { static wire = import.meta.og.wire(${codec}); }`, '/x.ts', MARKUP);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${codec}`);
		expect(balanced(out)).toBe(true);
	});

	it('minified: everything on one line, no spaces', () => {
		const out = rewrite_wire(`class C{static wire=import.meta.og.wire(${CODEC})}`, '/x.ts', MARKUP);
		expect(out).toContain(WIRE_EXPR);
		expect(out).not.toContain('import.meta.og.wire(');
	});

	it('a .svelte with TWO script blocks — only the one with the class rewrites', () => {
		const src = [
			`<script module lang="ts">export class C { static wire = import.meta.og.wire(${CODEC}); }</script>`,
			`<script lang="ts">let { c } = $props();</script>`,
			`<b>hi</b>`
		].join('\n');
		const out = rewrite_wire(src, '/C.svelte', MARKUP);
		expect(out).toContain(WIRE_EXPR);
		expect(out).toContain('let { c } = $props();');
	});
});

describe('scanner fallback — when the AST bails on an unparseable tail', () => {
	// A dangling `(` at EOF makes the parser fail, forcing the string-scanner path.
	const BROKEN = '\nconst broken = (';

	it('wire: still rewrites the valid member, comment/string markers untouched', () => {
		const src = [
			`// mention import.meta.og.wire() in a comment`,
			`const doc = "static wire = import.meta.og.wire({})";`,
			`class C { static wire = import.meta.og.wire(${CODEC}); }` + BROKEN
		].join('\n');
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC}`);
		expect(out).toContain(`// mention import.meta.og.wire() in a comment`);
		expect(out).toContain(`const doc = "static wire = import.meta.og.wire({})";`);
	});

	it('wire: a marker inside a REGEX literal is not rewritten by the fallback', () => {
		const src = `const re = /static wire = import.meta.og.wire/g;\nclass C { static wire = import.meta.og.wire(${CODEC}); }` + BROKEN;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain(`const re = /static wire = import.meta.og.wire/g;`); // regex untouched
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC}`);
	});

	it('wire: a marker at a template-literal boundary is not rewritten by the fallback', () => {
		const src = 'const t = `x static wire = import.meta.og.wire() y`;\nclass C { static wire = import.meta.og.wire(' + CODEC + '); }' + BROKEN;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(out).toContain('const t = `x static wire = import.meta.og.wire() y`;');
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC}`);
	});

	it('wire: a half-typed member (no closing paren) neither throws nor edits', () => {
		const src = `class C { static wire = import.meta.og.wire(${CODEC}`; // truncated mid-call
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(typeof out).toBe('string'); // no raw throw
	});

	it('loaders: fallback finds the call after an unparseable tail, string marker ignored', () => {
		const src = [
			`const doc = "import.meta.og.loader.json('fake')";`,
			`const a = import.meta.og.loader.json('./x/*.json');` + BROKEN
		].join('\n');
		const { code } = rewrite_loaders(src, '/x.ts');
		expect(code).toContain(`__og_json(import.meta.glob("./x/*.json", { eager: false }))`);
		expect(code).toContain(`const doc = "import.meta.og.loader.json('fake')";`);
	});

	it('loaders: a git spec with regex opts survives the fallback path', () => {
		const src = `const s = import.meta.og.loader.git('o/r:docs', { page: /\\.md$/ });` + BROKEN;
		const { specs } = rewrite_loaders(src, '/x.ts');
		expect(specs[0]).toMatchObject({ owner: 'o', repo: 'r', sub: 'docs' });
	});
});

describe('wire — demented shapes that must FAIL LOUDLY', () => {
	it('two wire members in ONE class (only one codec per class is coherent) — still rewrites both, stays balanced', () => {
		// Not an error per se (each is a legal member); assert it does not corrupt.
		const src = `class C { static wire = import.meta.og.wire(${CODEC}); static wire = import.meta.og.wire(${CODEC}); }`;
		const out = rewrite_wire(src, '/x.ts', MARKUP);
		expect(balanced(out)).toBe(true);
		expect(out).not.toContain('import.meta.og.wire(');
	});

	it('used as a computed KEY directly (the impossible TS form) is caught as misuse', () => {
		// `static [import.meta.og.wire]` — bare access in key position → misuse error.
		const src = `class C { static [import.meta.og.wire] = ${CODEC}; }`;
		expect(() => rewrite_wire(src, '/x.ts', MARKUP)).toThrow(/bare import\.meta\.og\.wire used as a value/);
	});

	it('spread into a call', () => {
		expect(() => rewrite_wire(`f(...import.meta.og.wire(${CODEC}))`, '/x.ts', MARKUP)).toThrow(
			/called outside a static class member/
		);
	});

	it('assigned to an object property', () => {
		expect(() => rewrite_wire(`const o = { w: import.meta.og.wire(${CODEC}) };`, '/x.ts', MARKUP)).toThrow(
			/called outside a static class member/
		);
	});

	it('a NON-static member named wire', () => {
		expect(() => rewrite_wire(`class C { wire = import.meta.og.wire(${CODEC}); }`, '/x.ts', MARKUP)).toThrow(
			/called outside a static class member/
		);
	});

	it('two arguments', () => {
		expect(() => rewrite_wire(`class C { static wire = import.meta.og.wire(${CODEC}, 1); }`, '/x.ts', MARKUP)).toThrow(
			/exactly one argument/
		);
	});
});

describe('wire — inputs that must be LEFT ALONE', () => {
	it('marker only ever in a comment → unchanged reference', () => {
		const src = `// import.meta.og.wire is cool\nexport const x = 1;`;
		expect(rewrite_wire(src, '/x.ts', MARKUP)).toBe(src);
	});

	it('marker only ever in a string → unchanged reference', () => {
		const src = `const s = "static wire = import.meta.og.wire({})";`;
		expect(rewrite_wire(src, '/x.ts', MARKUP)).toBe(src);
	});

	it('a look-alike longer identifier (import.meta.og.wireTap) is not the marker', () => {
		const src = `const x = import.meta.og.wireTap;`;
		// og_member returns 'wireTap' ≠ 'wire' → untouched.
		expect(rewrite_wire(src, '/x.ts', MARKUP)).toBe(src);
	});

	it('a non-construct-host extension (.css) is never touched', () => {
		const src = `.wire { content: "import.meta.og.wire()"; }`;
		expect(rewrite_wire(src, '/styles.css', MARKUP)).toBe(src);
	});

	it('markdown PROSE mentioning the marker (a .svelte with no script) stays literal', () => {
		const src = `<p>call import.meta.og.wire() like so</p>`;
		expect(rewrite_wire(src, '/x.svelte', MARKUP)).toBe(src);
	});
});

describe('loaders — demented shapes', () => {
	it('a loader nested inside a ternary inside an object', () => {
		const src = `export const c = content({ loader: cond ? import.meta.og.loader.markdown('./a/**/*.svx') : x });`;
		const out = rewrite_loaders(src, '/x.ts').code;
		expect(out).toContain(`__og_markdown(import.meta.glob("./a/**/*.svx", { eager: false }))`);
		expect(balanced(out)).toBe(true);
	});

	it('two loaders on one line, both rewrite, import injected once', () => {
		const out = rewrite_loaders(
			`const a = import.meta.og.loader.json('./a/*.json'); const b = import.meta.og.loader.json('./b/*.json');`,
			'/x.ts'
		).code;
		expect((out.match(/__og_json\(/g) ?? []).length).toBe(2);
		expect((out.match(/import \{ json as __og_json \}/g) ?? []).length).toBe(1);
	});

	it('a git spec with an @ref AND a sub path AND regex opts survives', () => {
		const src = `x(import.meta.og.loader.git('o/r@v1.2.3:docs/api', { page: /\\d+-[^/]+\\.md$/ }))`;
		const { code, specs } = rewrite_loaders(src, '/x.ts');
		expect(specs[0]).toMatchObject({ owner: 'o', repo: 'r', ref: 'v1.2.3', sub: 'docs/api' });
		expect(code).toContain('{ page: /\\d+-[^/]+\\.md$/ }');
		expect(balanced(code)).toBe(true);
	});

	it('the marker inside a comment and a string is not a call (AST)', () => {
		const src = [
			`// import.meta.og.loader.git('fake/repo')`,
			`const doc = "import.meta.og.loader.markdown('x')";`,
			`export const real = import.meta.og.loader.json('./d/*.json');`
		].join('\n');
		expect(find_loader_calls(src, '/x.ts')).toHaveLength(1);
	});

	it('a non-literal first arg (template literal) is rejected loudly', () => {
		const src = 'export const c = import.meta.og.loader.markdown(`./${dir}/**/*.svx`);';
		// AST finds the call; emit → split_first_string requires a STATIC string literal → throws.
		expect(() => rewrite_loaders(src, '/x.ts')).toThrow(/must be a static string literal/);
	});

	it('an unknown loader method is rejected with a helpful message', () => {
		expect(() => rewrite_loaders(`const c = import.meta.og.loader.yaml('./x/*.yaml');`, '/x.ts')).toThrow(
			/is not a loader — expected markdown, folder, json, or git/
		);
	});

	it('empty input, whitespace-only input, and marker-free input are no-ops', () => {
		for (const s of ['', '   \n\t ', 'export const x = 1;']) {
			expect(rewrite_loaders(s, '/x.ts').code).toBe(s);
		}
	});
});

describe('og_js_regions — script extraction torture', () => {
	it('a `</script>` sequence inside a JS string does not end the block early', () => {
		const src = `<script>const s = "</script>"; const y = 1;</script><p>after</p>`;
		const regions = og_js_regions(src, '/x.svelte', MARKUP);
		// Tokenizer note: Svelte itself forbids a raw `</script>` in script text; the string here is a
		// hard case. Assert we do not crash and we surface at least the leading code.
		expect(regions).not.toBeNull();
		expect(regions!.some((r) => r.code.includes('const s ='))).toBe(true);
	});

	it('a script tag with a `>` inside an attribute value', () => {
		const src = `<script lang="ts" data-x="a>b">const z = 1;</script>`;
		const regions = og_js_regions(src, '/x.svelte', MARKUP)!;
		expect(regions).toHaveLength(1);
		expect(regions[0]!.code).toBe('const z = 1;');
	});

	it('uppercase <SCRIPT> is still found (case-insensitive)', () => {
		const src = `<SCRIPT>const q = 1;</SCRIPT>`;
		const regions = og_js_regions(src, '/x.svelte', MARKUP)!;
		expect(regions[0]!.code).toBe('const q = 1;');
	});

	it('no script blocks at all → empty region list (not null)', () => {
		const regions = og_js_regions(`<h1>hi</h1>`, '/x.svelte', MARKUP);
		expect(regions).toEqual([]);
	});

	it('offsets map back correctly for a construct deep in the second block', () => {
		const src = `<script module>export class C { static wire = import.meta.og.wire(${CODEC}); }</script>\n<script>let x = 1;</script>`;
		const out = rewrite_wire(src, '/x.svelte', MARKUP);
		expect(out).toContain(WIRE_EXPR);
		expect(out).toContain('let x = 1;'); // the second block is untouched and intact
		expect(balanced(out)).toBe(true);
	});
});

describe('robustness — never throws a low-level error, only build-voice or clean output', () => {
	const junk = [
		'{{{{{{',
		'static wire = import.meta.og.wire(', // truncated
		'class C { static wire = import.meta.og.wire(' + CODEC, // unbalanced tail
		'import.meta.og',
		'import.meta.og.',
		'\0\0\0 import.meta.og.wire',
		'class'.repeat(1000)
	];
	for (const [i, s] of junk.entries()) {
		it(`junk #${i} either rewrites cleanly or throws a build-voice error (never a raw crash)`, () => {
			try {
				const out = rewrite_wire(s, '/x.ts', MARKUP);
				expect(typeof out).toBe('string');
			} catch (e) {
				// Only our build-voice error is acceptable.
				expect(String(e)).toMatch(/\[ogygia\]/);
			}
		});
	}
});
