// A snippet's ref id is derived from its descriptor (ref.ts `stable_id`, region-snippet.ts): two
// renders mint the same id — an island's fingerprint and its HTML stay put across requests. Only
// where equal descriptors truly are the same snippet: a slot by its id, frozen HTML by its hash, a
// live snippet only when its props are JSON-exact. A store keeps a random id (identity matters).
import { describe, expect, it } from 'vitest';
import { mint, resolve } from '../src/ref.js';
import { register_snippet_kind, slot_pointer } from '../src/region-snippet.js';

register_snippet_kind();
const branded = (d: object) => {
	const f = (() => {}) as unknown as { __ogRegion: object };
	f.__ogRegion = d;
	return f;
};
const id_of = (v: unknown) => mint(v, new Set(['snippet']))!.i;

describe('snippet ref ids', () => {
	it('two renders (two fresh snippet functions) of the same slot / static / plain live snippet mint the same id', () => {
		expect(id_of(slot_pointer('og1a-1'))).toBe(id_of(slot_pointer('og1a-1')));
		expect(id_of(slot_pointer('og1a-1'))).toBe('slot:og1a-1');
		expect(id_of(branded({ m: 'static', h: '<p>a</p>' }))).toBe(id_of(branded({ m: 'static', h: '<p>a</p>' })));
		const live = () => branded({ m: 'live', e: '/e.js', p: { title: 'Card', tags: ['a'], n: 2 } });
		expect(id_of(live())).toBe(id_of(live()));
	});

	it('different content, different ids', () => {
		expect(id_of(slot_pointer('og1'))).not.toBe(id_of(slot_pointer('og2')));
		expect(id_of(branded({ m: 'static', h: '<p>a</p>' }))).not.toBe(id_of(branded({ m: 'static', h: '<p>b</p>' })));
	});

	it('a live snippet whose props JSON cannot tell apart (a Map, a Date, a class) keeps a random id', () => {
		const a = branded({ m: 'live', e: '/e.js', p: { m: new Map([[1, 'x']]) } });
		const b = branded({ m: 'live', e: '/e.js', p: { m: new Map([[2, 'y']]) } });
		// (JSON.stringify writes both maps as {} — a content id would make them one snippet)
		expect(id_of(a)).not.toBe(id_of(b));
		expect(id_of(branded({ m: 'live', e: '/e.js', p: { at: new Date(0) } }))).not.toMatch(/^l/);
	});

	it('equal descriptors resolve to one revived snippet in the page scope (harmless: stateless)', () => {
		const r1 = mint(branded({ m: 'static', h: '<i>same</i>' }), new Set(['snippet']))!;
		const r2 = mint(branded({ m: 'static', h: '<i>same</i>' }), new Set(['snippet']))!;
		expect(r1.i).toBe(r2.i);
		const s1 = resolve(r1, 'page');
		const s2 = resolve(r2, 'page');
		expect(typeof s1).toBe('function');
		expect(typeof s2).toBe('function');
	});
});
