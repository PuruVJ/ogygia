/**
 * The twoslash directive strip — displayed fences must never show compiler directives we don't run,
 * while REAL code comments (including `// @ts-expect-error`) stay visible.
 */
import { describe, expect, it } from 'vitest';
import { twoslash_strip } from '../src/lib/markdown/twoslash-strip.ts';
import type { Fence } from 'ogygia/content/markdown';

const strip = twoslash_strip();
const fence = (source: string, lang = 'js'): Fence => ({ lang, raw_meta: '', meta: {}, source });

describe('directive stripping', () => {
	it('removes @errors lines', () => {
		const out = strip(fence(`// @errors: 7034 7005\nlet user;`));
		expect(out.source).toBe(`let user;`);
	});

	it('removes @filename, @noErrors, and @lib lines', () => {
		const out = strip(
			fence(`// @noErrors\n// @lib: dom\n// @filename: ambient.d.ts\ndeclare const x: number;`)
		);
		expect(out.source).toBe(`declare const x: number;`);
	});

	it('keeps real code comments, including // @ts-expect-error', () => {
		const src = `// @ts-expect-error\nconst a: string = 1;\n// @errors: 2322`;
		const out = strip(fence(src));
		expect(out.source).toBe(`// @ts-expect-error\nconst a: string = 1;`);
	});

	it('keeps prose comments that merely contain an @', () => {
		const src = `// email me @ example\nlet a;`;
		expect(strip(fence(src)).source).toBe(src);
	});
});

describe('---cut---', () => {
	it('shows only what is below the cut', () => {
		const out = strip(fence(`declare const preamble: 1;\n// ---cut---\nconst shown = true;`));
		expect(out.source).toBe(`const shown = true;`);
	});

	it('the LAST cut wins when there are several', () => {
		const out = strip(fence(`a;\n// ---cut---\nb;\n// ---cut---\nc;`));
		expect(out.source).toBe(`c;`);
	});

	it('combines with directive stripping (the multi-file preamble shape)', () => {
		const src = `// @filename: ambient.d.ts\ndeclare module '$lib/user';\n// @filename: index.js\n// ---cut---\nimport user from '$lib/user';`;
		expect(strip(fence(src)).source).toBe(`import user from '$lib/user';`);
	});
});

describe('scope and identity', () => {
	it('collapses the blank run a stripped block leaves at the top', () => {
		const out = strip(fence(`// @errors: 1\n\n\nlet a;`));
		expect(out.source).toBe(`let a;`);
	});

	it('applies to js, ts, and svelte fences', () => {
		for (const lang of ['js', 'ts', 'svelte']) {
			expect(strip(fence(`// @errors: 1\nx;`, lang)).source).toBe(`x;`);
		}
	});

	it('leaves other languages alone', () => {
		const src = `// @errors: 1\nx;`;
		expect(strip(fence(src, 'bash')).source).toBe(src);
	});

	it('returns the SAME fence object when nothing matches (no needless variant-cache churn)', () => {
		const f = fence(`const a = 1;`);
		expect(strip(f)).toBe(f);
	});
});
