/**
 * ADVERSARIAL stress suite for the content plugin's `import.meta.og.*` macros — code/md, regions and
 * loaders. Same contract as the wire/bake stress suite in core (og-constructs-stress.test.ts): every
 * input either does the RIGHT thing or FAILS LOUDLY (build-voice error), never silently corrupts,
 * never mistakes a comment/string for a call, never emits unbalanced output.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewrite_code, type CodeCall } from '../src/macros/code.ts';
import { rewrite_regions } from '../src/macros/regions.ts';
import { rewrite_loaders } from '../src/macros/loaders.ts';
import { __set_build_cache_root, run_browser_macros } from '@ogygia/core/internal/compiler-browser';

const MARKUP = ['.svelte'] as const;
const echo = async (c: CodeCall) =>
	c.kind === 'md' ? `<md>${c.source}</md>` : `<pre>${c.lang}:${c.source}</pre>`;

function balanced(s: string): boolean {
	let r = 0,
		c = 0;
	for (const ch of s) {
		if (ch === '(') r++;
		else if (ch === ')') r--;
		else if (ch === '{') c++;
		else if (ch === '}') c--;
	}
	return r === 0 && c === 0;
}

describe('code/md — demented shapes that must WORK', () => {
	it('the source contains the marker text as a string literal in the code', async () => {
		const src = 'const x = import.meta.og.code(`const s = "import.meta.og.code(1)"`, "ts");';
		const out = await rewrite_code(src, '/x.ts', MARKUP, echo);
		// the OUTER call rewrote; the inner marker was inside the baked string, now inert html
		expect(out).not.toMatch(/import\.meta\.og\.code\(`/);
		expect(out).toContain('__og_html_region(');
	});

	it('the code source contains backticks-as-content via escaping', async () => {
		const src = 'const x = import.meta.og.code(`const t = \\`hi\\``, "ts");';
		const out = await rewrite_code(src, '/x.ts', MARKUP, echo);
		expect(out).toContain('__og_html_region(');
		expect(balanced(out)).toBe(true);
	});

	it('md source containing a </script> sequence in a .ts host (valid there)', async () => {
		// A literal `</script>` in a .svelte <script> is invalid Svelte (must be `<\/script>`), so we
		// test the realistic host — a .ts module — where the sequence is a plain string. Output safety
		// (a `</script>` in the RENDERED html) is region-emit's `<`-escape, separately.
		const src = 'const d = import.meta.og.md(`text with </script> in it`);';
		const out = await rewrite_code(src, '/x.ts', MARKUP, echo);
		expect(out).toContain('__og_html_region(');
	});

	it('empty source string', async () => {
		const out = await rewrite_code(
			'const x = import.meta.og.code("", "ts");',
			'/x.ts',
			MARKUP,
			echo
		);
		expect(out).toContain('__og_html_region(');
	});

	it('deeply nested template with many ${}-looking but escaped sequences', async () => {
		const src = 'const x = import.meta.og.code(`a \\${b} c \\${d}`, "ts");';
		const out = await rewrite_code(src, '/x.ts', MARKUP, echo);
		expect(out).toContain('__og_html_region(');
	});

	it('the whole family markers appearing together, only code/md rewrite here', async () => {
		const src = [
			'const a = import.meta.og.code("x", "ts");',
			'const b = import.meta.og.md("# hi");',
			'const c = import.meta.og.wire;' // not ours to touch in rewrite_code
		].join('\n');
		const out = await rewrite_code(src, '/x.ts', MARKUP, echo);
		expect((out.match(/__og_html_region\(/g) ?? []).length).toBe(2);
		expect(out).toContain('import.meta.og.wire'); // left for the wire pass
	});
});

describe('code/md — byte-offset integrity under multi-byte unicode', () => {
	beforeAll(() => __set_build_cache_root(fs.mkdtempSync(path.join(os.tmpdir(), 'og-off-'))));

	it('code() with emoji prose before it splices correctly', async () => {
		const src = `const flag = "🚩🚩";\nconst x = import.meta.og.code("const y = 1;", "ts");\nconst tail = "🔥";`;
		const out = await rewrite_code(src, '/x.ts', MARKUP, echo);
		expect(out).toContain(`const flag = "🚩🚩";`);
		expect(out).toContain(`const tail = "🔥";`);
		expect(out).toContain('__og_html_region(');
		expect(out).not.toContain('import.meta.og.code(');
	});

	it('code + md interleaved on ONE line both rewrite, offsets independent', async () => {
		const src =
			'const p = import.meta.og.code("a", "ts"); const q = import.meta.og.md("# b"); const r = 3;';
		const out = await rewrite_code(src, '/x.ts', MARKUP, echo);
		expect((out.match(/__og_html_region\(/g) ?? []).length).toBe(2);
		expect(out).toContain('const r = 3;');
	});
});

describe('misuse-error QUALITY — build-voice, file:line, explains the fix', () => {
	// loaders: non-literal first arg + unknown method
	it('loader with an identifier first arg → static string literal', () => {
		expect(() =>
			rewrite_loaders(`const a = import.meta.og.loader.markdown(pattern);`, '/l.ts')
		).toThrow(/static string literal/);
	});
	it('loader with a concatenation first arg → static string literal', () => {
		expect(() =>
			rewrite_loaders('const a = import.meta.og.loader.json("./" + dir);', '/l.ts')
		).toThrow(/static string literal/);
	});
	it('unknown loader method → lists the valid loaders', () => {
		expect(() => rewrite_loaders(`const a = import.meta.og.loader.toml('./x');`, '/l.ts')).toThrow(
			/markdown, folder, json, or git/
		);
	});

	// regions: non-literal glob
	it('regions with a non-literal glob → static string literal', () => {
		expect(() =>
			rewrite_regions('const r = import.meta.og.regions(`./${d}/*.svelte`);', '/r.ts')
		).toThrow(/static string literal/);
	});

	// code/md: arity + non-literal
	it('code with an identifier source → static string literal + line', () => {
		expect(
			rewrite_code('const c = import.meta.og.code(src, "ts");', '/c.ts', MARKUP, echo)
		).rejects.toThrow(/c\.ts:1.*static string literal/);
	});
	it('md with wrong arity → takes exactly one argument', () => {
		expect(
			rewrite_code('const d = import.meta.og.md("a", "b");', '/c.ts', MARKUP, echo)
		).rejects.toThrow(/md\(text\) takes exactly one argument/);
	});
});

describe('code/md — must FAIL LOUDLY', () => {
	it('interpolated code source', async () => {
		await expect(
			rewrite_code('const x = import.meta.og.code(`${y}`, "ts");', '/x.ts', MARKUP, echo)
		).rejects.toThrow(/interpolation/);
	});
	it('interpolated md source', async () => {
		await expect(
			rewrite_code('const x = import.meta.og.md(`${y}`);', '/x.ts', MARKUP, echo)
		).rejects.toThrow(/interpolation/);
	});
	it('code with a computed/non-literal lang', async () => {
		await expect(
			rewrite_code('const x = import.meta.og.code("a", `t${s}`);', '/x.ts', MARKUP, echo)
		).rejects.toThrow(/lang.*static|interpolation/);
	});
	it('code with zero args', async () => {
		await expect(
			rewrite_code('const x = import.meta.og.code();', '/x.ts', MARKUP, echo)
		).rejects.toThrow(/2 or 3 arguments/);
	});
});

describe('.svelte multi-script-block interactions', () => {
	beforeAll(() => __set_build_cache_root(fs.mkdtempSync(path.join(os.tmpdir(), 'og-sv-'))));

	it('a <script module> wire class AND a <script> code() call both rewrite, blocks independent', async () => {
		const CODEC = `{ encode: (c) => c.v, decode: (v) => new W(v) }`;
		const src = [
			`<script module lang="ts">export class W { static wire = import.meta.og.wire(${CODEC}); }</script>`,
			`<script lang="ts">const snip = import.meta.og.code("const x = 1;", "ts");</script>`,
			`<div>{snip}</div>`
		].join('\n');
		// core's own module-macro pass (wire) first, then the content plugin's code macro
		const { code: wired } = await run_browser_macros(src, '/C.svelte');
		expect(wired).toContain("Symbol.for('ogygia.wire')");
		const coded = await rewrite_code(wired, '/C.svelte', MARKUP, echo);
		expect(coded).toContain('__og_html_region(');
		expect(coded).not.toContain('import.meta.og.code(');
		expect(balanced(coded)).toBe(true);
	});

	it('a DECOY string that looks like a call in another block is not rewritten', async () => {
		const src = [
			`<script module>const decoy = "const y = import.meta.og.code('x','ts')";</script>`,
			`<script>const real = import.meta.og.code("a", "ts");</script>`
		].join('\n');
		const out = await rewrite_code(src, '/C.svelte', MARKUP, echo);
		expect(out).toContain(`const decoy = "const y = import.meta.og.code('x','ts')"`); // decoy intact
		expect((out.match(/__og_html_region\(/g) ?? []).length).toBe(1); // only the real one
	});

	it('markup PROSE mimicking a call stays literal', async () => {
		const src = `<script>const c = import.meta.og.code("z", "ts");</script>\n<p>call import.meta.og.code() like so</p>`;
		const out = await rewrite_code(src, '/C.svelte', MARKUP, echo);
		expect(out).toContain('<p>call import.meta.og.code() like so</p>');
		expect(out).toContain('__og_html_region(');
	});
});

describe('regions — demented shapes', () => {
	let dir: string;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-regions-stress-'));
		fs.mkdirSync(path.join(dir, 'b'));
		fs.writeFileSync(path.join(dir, 'b', 'Weird Name.svelte'), 'x'); // space in filename
		fs.writeFileSync(path.join(dir, 'b', '$special.svelte'), 'x'); // $ in filename
		fs.writeFileSync(path.join(dir, 'b', 'normal.svelte'), 'x');
	});
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('filenames with spaces and special chars become string-keyed, importable specifiers', () => {
		const out = rewrite_regions(
			`export const r = import.meta.og.regions('./b/*.svelte');`,
			path.join(dir, 'r.ts')
		);
		expect(out).toContain('"Weird Name":');
		expect(out).toContain('"$special":');
		expect(out).toContain('"normal":');
		// each specifier is quoted, so a space in the path is safe
		expect(out).toContain('"./b/Weird Name.svelte"');
	});

	it('a glob matching NOTHING yields an empty registry, not a crash', () => {
		const out = rewrite_regions(
			`export const r = import.meta.og.regions('./b/*.nope');`,
			path.join(dir, 'r.ts')
		);
		expect(out).toContain('export const r = {  }');
		expect(out).not.toContain('import.meta.og.regions');
	});
});
