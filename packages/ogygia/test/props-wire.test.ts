/**
 * PROPS ON THE WIRE (server/props-wire.ts) — the lane, the canonical fingerprint input, the
 * tail-time seed references, the live-snippet entry scan and the sidecar tag. Exercised against a
 * real devalue / JSON round trip on both ends.
 */
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'devalue';
import {
	plan_props_wire,
	props_sidecar,
	stringify_props,
	WIRE_FORMAT_ATTR,
	WIRE_FORMAT_JSON
} from '../src/server/props-wire.js';
import { analyze, index_seed, SEED_REF_KEY, seed_ref_reviver } from '../src/seed-refs.js';
import { fingerprint_of } from '../src/runtime/fingerprint.js';

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ';
const block = (id: string) => ({
	id,
	title: `${id} title`,
	body: `${LOREM}(${id}) `.repeat(3),
	tags: ['a', 'b', id],
	meta: { weight: 3, links: [{ href: `/${id}/a`, label: 'A' }] }
});

describe('analyze · what one walk says', () => {
	it('a plain JSON tree is json + ref, sized, no thenable', () => {
		const m = analyze({ a: 1, b: 'x', c: [true, null, { d: 2.5 }] });
		expect(m).toMatchObject({ json: true, ref: true, thenable: false });
		expect(m.bytes).toBeGreaterThan(10);
	});

	it('an undefined PROPERTY keeps the JSON lane (JSON drops the key; a read gives undefined either way)', () => {
		const v = { a: 1, gone: undefined, deep: [{ x: undefined, y: 2 }] };
		expect(analyze(v)).toMatchObject({ json: true, ref: true });
		expect(JSON.parse(JSON.stringify(v))).toEqual({ a: 1, deep: [{ y: 2 }] });
	});

	it.each([
		['undefined array element', { a: [1, undefined, 3] }],
		['Date', { a: new Date(0) }],
		['bigint', { a: 1n }],
		['NaN', { a: NaN }],
		['Infinity', { a: -Infinity }],
		['-0', { a: -0 }]
	])('%s inside → not the JSON lane, still referenceable', (_, v) => {
		expect(analyze(v)).toMatchObject({ json: false, ref: true });
	});

	it.each([
		['Map', { a: new Map() }],
		['class instance', { a: new (class X {})() }],
		['function', { a: () => 1 }],
		['symbol-branded plain object (a held region, an og.$ fn descriptor)', { a: { [Symbol.for('ogygia.brand')]: true, x: 1 } }]
	])('%s inside → neither JSON nor referenceable', (_, v) => {
		expect(analyze(v)).toMatchObject({ json: false, ref: false });
	});

	it('a thenable anywhere flags the tree (and disqualifies both lanes)', () => {
		expect(analyze({ a: [{ b: Promise.resolve(1) }] })).toMatchObject({ thenable: true, json: false, ref: false });
	});

	it('a cycle is neither lane and never loops', () => {
		const v: Record<string, unknown> = { a: 1 };
		v.self = v;
		expect(analyze(v)).toMatchObject({ json: false, ref: false });
	});

	it('is memoised per root object (the seed is walked once per request)', () => {
		const v = { a: [1, 2, 3] };
		expect(analyze(v)).toBe(analyze(v));
	});
});

describe('plan_props_wire · lanes', () => {
	it('plain props take the JSON lane: canonical is JSON.stringify, the wire text is `<`-escaped', () => {
		const props = { label: '<b>hi</b>', n: [1, 2] };
		const w = plan_props_wire(props, '/islands/x.js');
		expect(w.json).toBe(true);
		expect(w.canonical).toBe(JSON.stringify(props));
		const out = w.wire(null);
		expect(out.json).toBe(true);
		expect(out.text).not.toContain('<');
		expect(JSON.parse(out.text)).toEqual(props);
	});

	it('anything devalue exists for keeps devalue, and needs no second escape', () => {
		const props = { when: new Date(1_700_000_000_000), tag: '</script>' };
		const w = plan_props_wire(props, '/islands/x.js');
		expect(w.json).toBe(false);
		const out = w.wire(null);
		expect(out.json).toBe(false);
		expect(out.text).not.toContain('<');
		expect(parse(out.text)).toEqual(props);
	});

	it('a non-serializable prop (a class instance with no codec) throws the teaching error', () => {
		class Opaque {
			v = 1;
		}
		expect(() => plan_props_wire({ o: new Opaque() }, '/islands/x.js')).toThrow(/island "\/islands\/x.js": a captured prop/);
	});
});

describe('plan_props_wire · fingerprint input', () => {
	it('the fingerprint is a function of the props alone: same with or without the seed', () => {
		const data = { catalog: { blocks: [block('one'), block('two')] } };
		const props = { block: data.catalog.blocks[0], mode: 'x' };
		const w = plan_props_wire(props, '/islands/x.js');
		const fp = fingerprint_of('/islands/x.js', '', w.canonical);
		// referenced or not, the wire text differs but the canonical (what data-og-fp hashes) does not
		expect(w.wire(index_seed(data)).text).not.toBe(w.wire(null).text);
		expect(fingerprint_of('/islands/x.js', '', w.canonical)).toBe(fp);
		expect(fingerprint_of('/islands/x.js', '', plan_props_wire(structuredClone(props), '/islands/x.js').canonical)).toBe(fp);
	});
});

describe('plan_props_wire · seed references at wire time', () => {
	const data = { catalog: { blocks: [block('one'), block('two')] }, greeting: 'hi' };

	it('with the seed index: a seed node (identity or clone) crosses as a path, revives equal', () => {
		const props = { block: data.catalog.blocks[0], twin: JSON.parse(JSON.stringify(data.catalog.blocks[1])), n: 7 };
		const w = plan_props_wire(props, '/islands/x.js');
		expect(w.json).toBe(true); // plain props: JSON canonical …
		const out = w.wire(index_seed(data));
		expect(out.json).toBe(false); // … but devalue on the wire once references apply
		expect(out.text.split(SEED_REF_KEY).length - 1).toBe(2);
		expect(out.text.length).toBeLessThan(w.canonical.length / 3);
		const revived = parse(out.text, { [SEED_REF_KEY]: seed_ref_reviver(() => data) });
		expect(revived).toEqual(props);
	});

	it('without the seed (null), or with a seed that owns none of the props: the canonical lane', () => {
		const props = { block: data.catalog.blocks[0] };
		const w = plan_props_wire(props, '/islands/x.js');
		expect(w.wire(null)).toEqual({ text: w.canonical, json: true });
		expect(w.wire(index_seed({ other: block('zzz') })).json).toBe(true);
		expect(w.wire(index_seed({})).json).toBe(true);
	});

	it('devalue-lane props reference too (a Date next to a seed node)', () => {
		const props = { block: data.catalog.blocks[1], at: new Date(5) };
		const w = plan_props_wire(props, '/islands/x.js');
		expect(w.json).toBe(false);
		const out = w.wire(index_seed(data));
		expect(out.text).toContain(SEED_REF_KEY);
		expect(parse(out.text, { [SEED_REF_KEY]: seed_ref_reviver(() => data) })).toEqual(props);
	});

	it('the same plan can be wired twice (identical islands share a sidecar render)', () => {
		const w = plan_props_wire({ block: data.catalog.blocks[0] }, '/islands/x.js');
		const idx = index_seed(data);
		expect(w.wire(idx).text).toBe(w.wire(idx).text);
	});
});

describe('live snippet entries', () => {
	it('finds every distinct live-region entry URL in a devalue payload, any appDir', () => {
		// a live region snippet is a branded function in real props; here the descriptor shape is
		// emulated with a Date so the props take the devalue lane and carry the URL strings verbatim
		const props = {
			at: new Date(1),
			a: { m: 'live', e: '/_app/immutable/og-region.abc123.js' },
			b: { m: 'live', e: '/custom-dir/immutable/og-region.def456.js' },
			c: { m: 'live', e: '/_app/immutable/og-region.abc123.js' },
			not: '/_app/immutable/chunks/x.js'
		};
		const w = plan_props_wire(props, '/islands/x.js');
		expect(w.live_entries).toEqual([
			'/_app/immutable/og-region.abc123.js',
			'/custom-dir/immutable/og-region.def456.js'
		]);
	});

	it('a JSON-lane payload never carries one (a live snippet is a function)', () => {
		expect(plan_props_wire({ e: '/_app/immutable/og-region.abc123.js' }, '/x').live_entries).toEqual([]);
	});
});

describe('props_sidecar', () => {
	it('keyed: data-ogygia-props + id; JSON lane: the format attribute', () => {
		expect(props_sidecar('ab12', { text: '{"a":1}', json: true })).toBe(
			`<script type="application/ogygia-props" data-ogygia-props="ab12" id="og-props-ab12" ${WIRE_FORMAT_ATTR}="${WIRE_FORMAT_JSON}">{"a":1}</script>`
		);
	});

	it('unkeyed devalue (a hole, a held region): bare attribute, no format', () => {
		expect(props_sidecar('', { text: '[1]', json: false })).toBe(
			'<script type="application/ogygia-props" data-ogygia-props>[1]</script>'
		);
	});
});

describe('stringify_props', () => {
	it('matches plain devalue for plain values and registers the prop kinds once', () => {
		const v = { a: [1, 'two', { three: 3 }] };
		expect(stringify_props(v, '/x')).toBe(stringify(v));
	});
});
