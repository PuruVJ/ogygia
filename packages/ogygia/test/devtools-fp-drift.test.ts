// An island's fingerprint moving between two loads of the same page (devtools/fp-drift.ts): matched by
// entry and copy, named with the prop that differs — and never for ogygia's own ids (a store's or a
// class instance's, random per render by design).
import { describe, expect, it } from 'vitest';
import { stringify } from 'devalue';
import { compare, props_diff } from '../src/devtools/fp-drift.js';

describe('fp drift', () => {
	it('names the prop that differs (JSON lane): a nested path, the two values', () => {
		expect(props_diff('{"label":"a","price":{"at":1}}', '{"label":"a","price":{"at":2}}')).toEqual({ path: 'price.at', was: '1', now: '2' });
		expect(props_diff('{"items":[{"id":"a"},{"id":"b"}]}', '{"items":[{"id":"a"},{"id":"c"}]}')).toEqual({ path: 'items[1].id', was: '"b"', now: '"c"' });
	});

	it('ogygia’s own ids are left out: only they differ → no drift', () => {
		const a = '{"cart":1,"ref":{"k":"store","i":"8abbcc0c-8898-4cb0-b37d-30c8d0c5d149"}}';
		const b = '{"cart":1,"ref":{"k":"store","i":"bfa88d49-b4a9-4469-baad-ffe787a5fa4d"}}';
		expect(props_diff(a, b)).toBeNull();
		// …and in a text that parses as neither lane, the same way
		expect(props_diff('x("8abbcc0c-8898-4cb0-b37d-30c8d0c5d149")', 'x("bfa88d49-b4a9-4469-baad-ffe787a5fa4d")')).toBeNull();
		// an id beside a real change: the real change is named
		expect(props_diff('{"n":1,"i":"8abbcc0c-8898-4cb0-b37d-30c8d0c5d149"}', '{"n":2,"i":"bfa88d49-b4a9-4469-baad-ffe787a5fa4d"}')).toEqual({ path: 'n', was: '1', now: '2' });
	});

	it('the devalue lane: the prop is named by its path in the props, never a slot of the flat table', () => {
		const a = stringify({ cart: { count: 3, at: new Date(0) }, ref: { k: 'store', i: '8abbcc0c-8898-4cb0-b37d-30c8d0c5d149' } });
		const b = stringify({ cart: { count: 5, at: new Date(0) }, ref: { k: 'store', i: 'bfa88d49-b4a9-4469-baad-ffe787a5fa4d' } });
		expect(props_diff(a, b)).toEqual({ path: 'cart.count', was: '3', now: '5' });
		// a custom type the comparer has no reviver for: kept as a value, and compared inside
		const c = stringify({ x: new URL('http://a/1') }, { URL: (v) => v instanceof URL && v.href });
		const d = stringify({ x: new URL('http://a/2') }, { URL: (v) => v instanceof URL && v.href });
		expect(props_diff(c, d)).toEqual({ path: 'x.<URL>', was: '"http://a/1"', now: '"http://a/2"' });
		// a value inside ogygia's ref wrapper (a store's): named as the author wrote it
		class Ref {
			constructor(
				readonly k: string,
				readonly d: unknown
			) {}
		}
		const reducers = { OgygiaRef: (v: unknown) => v instanceof Ref && { k: v.k, d: v.d } };
		const g = stringify({ cart: new Ref('store', { stamp: 1 }) }, reducers);
		const h = stringify({ cart: new Ref('store', { stamp: 2 }) }, reducers);
		expect(props_diff(g, h)?.path).toBe('cart.stamp');
		// only the ref's id moved: quiet
		const e = stringify({ ref: { k: 'store', i: '8abbcc0c-8898-4cb0-b37d-30c8d0c5d149' } });
		const f = stringify({ ref: { k: 'store', i: 'bfa88d49-b4a9-4469-baad-ffe787a5fa4d' } });
		expect(props_diff(e, f)).toBeNull();
	});

	it('islands are matched by entry and their place among copies; an unchanged one is quiet', () => {
		const was = [
			{ entry: '/A.js', fp: 'a1', props: '{"t":1}' },
			{ entry: '/A.js', fp: 'a2', props: '{"t":9}' },
			{ entry: '/B.js', fp: 'b1', props: '{"x":1}' }
		];
		const now = [
			{ entry: '/A.js', fp: 'a1', props: '{"t":1}' },
			{ entry: '/A.js', fp: 'a3', props: '{"t":10}' },
			{ entry: '/B.js', fp: 'b1', props: '{"x":1}' }
		];
		expect(compare(was, now)).toEqual([{ entry: '/A.js', fp_was: 'a2', fp_now: 'a3', path: 't', was: '9', now: '10' }]);
		// a first load: nothing to compare
		expect(compare([], now)).toEqual([]);
	});
});
