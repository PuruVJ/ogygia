import { describe, expect, it } from 'vitest';
import {
	infostring,
	slash_meta,
	run_meta,
	run_variants,
	type Fence,
	type VariantGenerator
} from '../src/content/markdown/code.js';

const fence = (over: Partial<Fence> = {}): Fence => ({
	lang: 'js',
	raw_meta: '',
	meta: {},
	source: 'const a = 1;',
	...over
});

describe('fence meta parsers', () => {
	it('infostring() reads chrome meta (title→file, quoted, bare, booleans); ignores line ranges', () => {
		const f = run_meta([infostring()], fence({ raw_meta: 'title="app.js" copy=false {1-3,5}' }));
		expect(f.meta).toEqual({ title: 'app.js', file: 'app.js', copy: false });
		// the {1-3,5} is NOT parsed here — it's the raw infostring Shiki's transformer reads
		expect(f.meta.highlight).toBeUndefined();
	});

	it('slash_meta() reads /// file:/copy:/link: and STRIPS them from source', () => {
		const src = '/// file: App.svelte\n/// copy: false\nconst a = 1;';
		const f = run_meta([slash_meta()], fence({ source: src }));
		expect(f.meta).toEqual({ file: 'App.svelte', copy: false });
		expect(f.source).toBe('const a = 1;');
	});

	it('parsers LAYER (later wins on collision)', () => {
		const f = run_meta(
			[infostring(), slash_meta()],
			fence({ raw_meta: 'file="from-info.js"', source: '/// file: from-slash.js\nx;' })
		);
		expect(f.meta.file).toBe('from-slash.js'); // slash_meta ran after → wins
		expect(f.source).toBe('x;');
	});
});

describe('run_variants — race', () => {
	const genFor = (lang: string, out: string): VariantGenerator => ({
		pref: { name: 'p', values: ['a', 'b'], default: 'a' },
		generate: (f) => (f.lang === lang ? [{ label: out, value: out, fence: f }] : null)
	});

	it('the FIRST generator to return non-null claims the fence', () => {
		const res = run_variants([genFor('ts', 'x'), genFor('js', 'y')], fence({ lang: 'js' }));
		expect(res?.variants[0]!.value).toBe('y');
		expect(res?.by.pref.name).toBe('p');
	});

	it('no generator claims → null', () => {
		expect(run_variants([genFor('ts', 'x')], fence({ lang: 'css' }))).toBeNull();
	});
});
