import { describe, expect, it } from 'vitest';
import { js_specifiers } from '../src/index.ts';

describe('js_specifiers', () => {
	it('points relative .ts imports at the built .js modules', () => {
		const src = [
			"import { a } from './a.ts';",
			"import './side.ts';",
			"const m = await import('../m.ts');",
			"/** @type {import('./region.ts').RegionValue} */",
			"export { b } from './b.svelte.ts';"
		].join('\n');
		expect(js_specifiers(src)).toBe(
			[
				"import { a } from './a.js';",
				"import './side.js';",
				"const m = await import('../m.js');",
				"/** @type {import('./region.js').RegionValue} */",
				"export { b } from './b.svelte.js';"
			].join('\n')
		);
	});

	it('leaves packages, other extensions and non-import strings alone', () => {
		const src = [
			"import x from 'pkg/thing.ts';",
			"import C from './C.svelte';",
			"const u = new URL('./w.ts', import.meta.url);",
			"const s = 'from ./a.ts';"
		].join('\n');
		expect(js_specifiers(src)).toBe(src);
	});
});
