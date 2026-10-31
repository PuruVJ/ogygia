/**
 * ADVERSARIAL stress suite for the `import.meta.og.loader.*` macro. The contract every case asserts:
 * the rewrite either does the RIGHT thing or FAILS LOUDLY — it never silently corrupts, never
 * rewrites a comment/string, never throws an unhelpful low-level error, never produces unbalanced
 * output. (The wire half of this suite lives in core's og-transform-stress.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { rewrite_loaders, find_loader_calls } from '../src/macros/loaders.ts';

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

describe('scanner fallback — when the AST bails on an unparseable tail', () => {
	// A dangling `(` at EOF makes the parser fail, forcing the string-scanner path.
	const BROKEN = '\nconst broken = (';

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
		expect(() =>
			rewrite_loaders(`const c = import.meta.og.loader.yaml('./x/*.yaml');`, '/x.ts')
		).toThrow(/is not a loader — expected markdown, folder, json, or git/);
	});

	it('empty input, whitespace-only input, and marker-free input are no-ops', () => {
		for (const s of ['', '   \n\t ', 'export const x = 1;']) {
			expect(rewrite_loaders(s, '/x.ts').code).toBe(s);
		}
	});
});
