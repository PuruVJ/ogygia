import { describe, expect, it } from 'vitest';
import { rewrite_code, type CodeCall } from '../src/vite/og-code.js';
import { dedent } from '../src/vite/dedent.js';

const MARKUP = ['.svelte'] as const;
// A fake renderer: echoes its inputs so tests assert what the macro EXTRACTED (dedent, lang, meta),
// independent of Shiki. Real rendering is exercised by the app build.
const echo = async (c: CodeCall) =>
	c.kind === 'md'
		? `<div data-md>${c.source}</div>`
		: `<pre data-lang="${c.lang}" data-meta="${c.meta}">${c.source}</pre>`;

describe('dedent', () => {
	it('strips common leading indentation and trims blank first/last lines', () => {
		const input = '\n\t\t\tconst x = 1;\n\t\t\tif (x) {\n\t\t\t\treturn x;\n\t\t\t}\n\t\t\t';
		expect(dedent(input)).toBe('const x = 1;\nif (x) {\n\treturn x;\n}');
	});
	it('blank lines do not constrain the common indent', () => {
		expect(dedent('\n    a\n\n    b\n')).toBe('a\n\nb');
	});
	it('leaves already-flush text alone', () => {
		expect(dedent('a\nb')).toBe('a\nb');
	});
	it('empty / whitespace-only → empty', () => {
		expect(dedent('   \n\t\n')).toBe('');
	});
});

describe('rewrite_code', () => {
	it('bakes a template-literal snippet, dedents it, and inlines og_html_region', async () => {
		const src = [
			'const ex = import.meta.og.code(`',
			'\tconst a = 1;',
			'\tconst b = 2;',
			'`, "ts");'
		].join('\n');
		const out = await rewrite_code(src, '/app/x.ts', MARKUP, echo);
		expect(out).toContain(`import { og_html_region as __og_html_region } from 'ogygia';`);
		expect(out).toContain('__og_html_region(');
		expect(out).not.toContain('import.meta.og.code');
		// dedented (no leading tab) and lang threaded
		expect(out).toContain('const a = 1;\\nconst b = 2;');
		expect(out).toContain('data-lang=\\"ts\\"');
	});

	it('threads the meta infostring through as the third arg', async () => {
		const src = 'const ex = import.meta.og.code("x", "ts", "twoslash {2-4} file=app.ts");';
		const out = await rewrite_code(src, '/app/x.ts', MARKUP, echo);
		expect(out).toContain('data-meta=\\"twoslash {2-4} file=app.ts\\"');
	});

	it('works inside a .svelte <script> block; the import lands at the block top; prose untouched', async () => {
		const src = [
			'<script>',
			'const ex = import.meta.og.code("y", "js");',
			'</script>',
			'<p>import.meta.og.code() in prose stays literal</p>'
		].join('\n');
		const out = await rewrite_code(src, '/app/C.svelte', MARKUP, echo);
		expect(out).toContain(`import { og_html_region as __og_html_region } from 'ogygia';`);
		expect(out).toContain('__og_html_region(');
		expect(out).toContain('<p>import.meta.og.code() in prose stays literal</p>');
	});

	it('rejects an interpolated template source (build error)', async () => {
		const src = 'const ex = import.meta.og.code(`const x = ${y};`, "ts");';
		await expect(rewrite_code(src, '/app/x.ts', MARKUP, echo)).rejects.toThrow(/interpolation/);
	});

	it('rejects a non-literal lang', async () => {
		const src = 'const ex = import.meta.og.code("x", lang);';
		await expect(rewrite_code(src, '/app/x.ts', MARKUP, echo)).rejects.toThrow(/lang must be a static string literal/);
	});

	it('rejects wrong arity', async () => {
		const src = 'const ex = import.meta.og.code("x");';
		await expect(rewrite_code(src, '/app/x.ts', MARKUP, echo)).rejects.toThrow(/takes 2 or 3 arguments/);
	});

	it('ignores the marker in a comment or string', async () => {
		const src = [
			'// import.meta.og.code("fake", "ts")',
			'const doc = "import.meta.og.code(1)";',
			'const real = import.meta.og.code("z", "ts");'
		].join('\n');
		const out = await rewrite_code(src, '/app/x.ts', MARKUP, echo);
		expect((out.match(/__og_html_region\(/g) ?? []).length).toBe(1);
		expect(out).toContain('// import.meta.og.code("fake", "ts")');
	});

	it('returns the same reference when there is nothing to do', async () => {
		const src = 'export const x = 1;';
		expect(await rewrite_code(src, '/app/x.ts', MARKUP, echo)).toBe(src);
	});

	it('multiple snippets in one module all bake and the import injects once', async () => {
		const src = 'const a = import.meta.og.code("a", "ts"); const b = import.meta.og.code("b", "js");';
		const out = await rewrite_code(src, '/app/x.ts', MARKUP, echo);
		expect((out.match(/__og_html_region\(/g) ?? []).length).toBe(2);
		expect((out.match(/import \{ og_html_region/g) ?? []).length).toBe(1);
	});
});

describe('rewrite_code — md()', () => {
	it('bakes a markdown string (dedented) and inlines og_html_region', async () => {
		const src = ['const doc = import.meta.og.md(`', '\t# Title', '\tsome **bold** prose', '`);'].join('\n');
		const out = await rewrite_code(src, '/app/x.ts', MARKUP, echo);
		expect(out).toContain(`import { og_html_region as __og_html_region } from 'ogygia';`);
		expect(out).toContain('__og_html_region(');
		expect(out).toContain('# Title\\nsome **bold** prose'); // dedented, whole text as one arg
		expect(out).not.toContain('import.meta.og.md');
	});

	it('rejects md() with wrong arity', async () => {
		await expect(rewrite_code('const d = import.meta.og.md("a", "b");', '/app/x.ts', MARKUP, echo)).rejects.toThrow(
			/md\(text\) takes exactly one argument/
		);
	});

	it('rejects an interpolated md() template', async () => {
		await expect(rewrite_code('const d = import.meta.og.md(`# ${title}`);', '/app/x.ts', MARKUP, echo)).rejects.toThrow(
			/interpolation/
		);
	});

	it('code() and md() coexist in one module; one import injected', async () => {
		const src = 'const a = import.meta.og.code("x", "ts"); const b = import.meta.og.md("# hi");';
		const out = await rewrite_code(src, '/app/x.ts', MARKUP, echo);
		expect((out.match(/__og_html_region\(/g) ?? []).length).toBe(2);
		expect((out.match(/import \{ og_html_region/g) ?? []).length).toBe(1);
		expect(out).toContain('data-md');
		expect(out).toContain('data-lang');
	});
});
