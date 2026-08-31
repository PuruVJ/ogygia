/**
 * The FN kind (runtime half of `import.meta.og.$`): a closure crosses as a QRL-style handle —
 * code tag + bound captures — and rebinds on the other side. The compiler half (hoisting) is a
 * later phase; these tests exercise exactly what generated code will call.
 */
import { describe, it, expect } from 'vitest';
import { get, writable } from 'svelte/store';
import { parse, stringify } from 'devalue';
import { __register_fn, fn_handle } from '../src/fn-transport.js';
import { REF_WIRE_KEY, ref_reducer, ref_reviver, resolve } from '../src/ref.js';
import { register_store_kind } from '../src/store-transport.js';
register_store_kind(); // a bound capture below is a store — its kind must be registered in THIS graph

const FAMILIES = new Set(['fn', 'store']);
const enc = (v: unknown) => stringify(v, { [REF_WIRE_KEY]: ref_reducer(FAMILIES) });
const dec = (s: string) => parse(s, { [REF_WIRE_KEY]: ref_reviver(true) as (d: never) => unknown });

describe('fn kind (og.$ runtime half)', () => {
	it('round-trip: handle crosses, client rebinds captures, call works', () => {
		// what the COMPILER will generate from: og.$((n) => `€${(n * (1 + tax)).toFixed(2)}`)
		__register_fn(
			'test/layout#$fmt',
			(tax: number) => (n: number) => `€${(n * (1 + tax)).toFixed(2)}`
		);
		const live = fn_handle('test/layout#$fmt', [0.19]); // the call-site rewrite
		expect((live as (n: number) => string)(100)).toBe('€119.00'); // SERVER leg: real fn immediately

		const revived = dec(enc({ fmt: live })) as { fmt: (n: number) => string };
		expect(typeof revived.fmt).toBe('function');
		expect(revived.fmt(100)).toBe('€119.00'); // captures rebound on the other side
	});

	it('a revived fn can cross a FURTHER boundary (re-branded)', () => {
		__register_fn('test/x#$id', (p: string) => () => p);
		const hop1 = dec(enc(fn_handle('test/x#$id', ['alpha']))) as () => string;
		const hop2 = dec(enc(hop1)) as () => string; // island → island prop
		expect(hop2()).toBe('alpha');
	});

	it('bound captures participate in the hub: a store capture reunites (shared live state)', () => {
		const counter = writable(0);
		__register_fn('test/y#$inc', (store: typeof counter) => () => store.update((n) => n + 1));
		const payload = enc({ inc: fn_handle('test/y#$inc', [counter]), counter });
		const out = dec(payload) as { inc: () => void; counter: typeof counter };
		out.inc(); // the fn's captured store IS the same instance the context carries
		expect(get(out.counter)).toBe(1);
	});

	it('unregistered tag at the call site throws a located error', () => {
		expect(() => fn_handle('test/ghost#$0', [])).toThrow(/fn_handle\("test\/ghost#\$0"\)/);
	});

	it('registry MISS + source on the wire → rebuilt from the payload (the prod fallback)', () => {
		__register_fn('test/z#$0', (p: string) => () => 'ok:' + p);
		const payload = enc(fn_handle('test/z#$0', ['a']));
		// a bundle that never loaded the generated module: ghost tag, but the source rides along
		const forged = payload.replaceAll('test/z#$0', 'test/zz#$missing');
		const revived = dec(forged) as () => string;
		expect(revived()).toBe('ok:a');
	});

	it('registry miss + NO source → throws naming the tag', () => {
		// a source-less ref (an old writer / stripped payload) resolved directly through the hub
		expect(() => resolve({ k: 'fn', i: 'i-x', t: 'test/ghost2#$0', d: { b: [] } }, true)).toThrow(
			/cannot revive fn "test\/ghost2#\$0"/
		);
	});

	it('a BARE function is never claimed by the fn kind (boundary law preserved)', () => {
		expect(() => enc({ cb: () => {} })).toThrow(); // devalue rejects — same loud failure as before
	});
});

describe('og.$ boundary assertion runtime (__og_boundary) + fn as island prop', () => {
	it("legal values pass through untouched (mark-don't-wrap)", async () => {
		const { __og_boundary } = await import('../src/boundary.js');
		const store = writable(1);
		expect(__og_boundary(store, 'x.ts:1')).toBe(store);
		expect(__og_boundary({ a: 1 }, 'x.ts:2')).toEqual({ a: 1 });
	});

	it('a refusal throws AT THE MARK with the site', async () => {
		const { __og_boundary } = await import('../src/boundary.js');
		expect(() =>
			__og_boundary({ el: { nodeType: 1, nodeName: 'DIV' } }, 'src/routes/p.svelte:9')
		).toThrow(/src\/routes\/p\.svelte:9.*DOM node/s);
		expect(() => __og_boundary({ cb: () => {} }, 'x.ts:3')).toThrow(/bare function/);
	});

	it('an og.$ fn crosses as an ISLAND PROP (fn family; snippet kind must not freeze it)', async () => {
		const { encode_region_props } = await import('../src/server/region-props.js');
		__register_fn('test/prop#$0', (p: number) => (n: number) => n + p);
		const live = fn_handle('test/prop#$0', [10]);
		const payload = encode_region_props({ adder: live, label: 'x' });
		expect(payload).not.toBeNull(); // crossed — not frozen, not rejected
		const { B64Url } = await import('../src/server/payload.js');
		const { REF_WIRE_KEY, ref_reviver } = await import('../src/ref.js');
		const props = parse(B64Url.decode(payload!), {
			[REF_WIRE_KEY]: ref_reviver(true) as (d: never) => unknown
		}) as {
			adder: (n: number) => number;
			label: string;
		};
		expect(props.label).toBe('x');
		expect(props.adder(5)).toBe(15); // rebound with its capture
	});
});
