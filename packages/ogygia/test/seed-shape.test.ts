// SEED SHAPING — the server half: asks fold into one answer per request, and the seed's `page.data`
// is cut to it. A measured CMS home page shipped 368 KB of page data for islands that read three
// keys of it; with shaping the same page ships those three.
import { describe, expect, it } from 'vitest';
import { merge_seed_ask, shape_page_data } from '../src/server/seed-shape.js';

describe('merge_seed_ask', () => {
	it('false asks nothing; keys union; all absorbs', () => {
		expect(merge_seed_ask(null, false)).toBeNull();
		expect(merge_seed_ask(null, ['a'])).toEqual(new Set(['a']));
		expect(merge_seed_ask(new Set(['a']), ['b', 'a'])).toEqual(new Set(['a', 'b']));
		expect(merge_seed_ask(new Set(['a']), 'all')).toBe('all');
		expect(merge_seed_ask('all', ['b'])).toBe('all');
		expect(merge_seed_ask('all', false)).toBe('all');
	});
});

describe('shape_page_data', () => {
	const data = { _locale: 'fr-FR', big: 'x'.repeat(1000), user: { name: 'p' }, nested: { a: 1 } };
	it('picks the asked keys, keeps value identity, leaves absent keys absent', () => {
		const out = shape_page_data(data, new Set(['_locale', 'user', 'missing'])) as Record<string, unknown>;
		expect(Object.keys(out).sort()).toEqual(['_locale', 'user']);
		expect(out.user).toBe(data.user); // same node: a props sidecar referencing it still resolves
		expect('big' in out).toBe(false);
	});
	it('all and null ship the tree as is; non-objects pass through', () => {
		expect(shape_page_data(data, 'all')).toBe(data);
		expect(shape_page_data(data, null)).toBe(data);
		expect(shape_page_data(undefined, new Set(['a']))).toBeUndefined();
		expect(shape_page_data([1, 2], new Set(['0']))).toEqual([1, 2]);
	});
	it('an empty ask ships an empty data object (the island reads only url / params)', () => {
		expect(shape_page_data(data, new Set())).toEqual({});
	});
});
