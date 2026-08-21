/**
 * `import.meta.og.store` — the store-factory assert construct + its runtime (__og_store).
 * The corpus case it clears: a house factory's custom methods surviving the island wire.
 */
import { describe, it, expect } from 'vitest';
import { get, writable, derived } from 'svelte/store';
import { parse, stringify } from 'devalue';
import { rewrite_store, auto_brand_stores } from '../src/compiler/macros/store.js';
import {
	__og_store,
	mark_store,
	reduce_store,
	revive_store,
	STORE_WIRE_KEY,
	is_store,
	og_derived,
	register_derived_kind
} from '../src/store-transport.js';
import { __register_fn, fn_handle } from '../src/fn-transport.js';
import { REF_WIRE_KEY, ref_reducer, ref_reviver } from '../src/ref.js';

const SVELTE = ['.svelte'];
const run = (src: string, id = 'src/lib/cart.ts') => rewrite_store(src, id, id, SVELTE);
const enc = (v: unknown) => stringify(v, { [STORE_WIRE_KEY]: reduce_store });
const dec = (s: string) => parse(s, { [STORE_WIRE_KEY]: (d: never) => revive_store(d, true) });

describe('og.store transform', () => {
	it('rewrites the mark to __og_store(tag, factory) and injects the import', () => {
		const src = `export const createCart = import.meta.og.store((seed = []) => ({ subscribe: () => {}, seed }));`;
		const code = run(src);
		expect(code).toContain(`import { __og_store } from 'ogygia/internal';`);
		expect(code).toContain(
			`__og_store("src/lib/cart.ts#store0", (seed = []) => ({ subscribe: () => {}, seed }))`
		);
	});

	it('accepts an identifier argument; sequential tags per module', () => {
		const src = `function make(s) { return { subscribe: () => {}, s }; }\nexport const a = import.meta.og.store(make);\nexport const b = import.meta.og.store((x) => make(x));`;
		const code = run(src);
		expect(code).toContain(`__og_store("src/lib/cart.ts#store0", make)`);
		expect(code).toContain(`__og_store("src/lib/cart.ts#store1", (x) => make(x))`);
	});

	it('works in a .svelte script block; no marker → same reference', () => {
		const sv = `<script>\n\tconst s = import.meta.og.store((v) => ({ subscribe: () => {}, v }));\n</script>`;
		expect(rewrite_store(sv, 'src/X.svelte', 'src/X.svelte', SVELTE)).toContain(
			`__og_store("src/X.svelte#store0"`
		);
		const plain = `export const x = 1;`;
		expect(run(plain)).toBe(plain);
	});

	it('BUILD ERRORS: arg count, non-function arg, bare access', () => {
		expect(() => run(`const f = import.meta.og.store();`)).toThrow(/exactly one argument/);
		expect(() => run(`const f = import.meta.og.store(a, b);`)).toThrow(/exactly one argument/);
		expect(() => run(`const f = import.meta.og.store(42);`)).toThrow(
			/function expression or an identifier/
		);
		expect(() => run(`const alias = import.meta.og.store;`)).toThrow(/bare import.meta.og.store/);
	});
});

describe('__og_store runtime (the corpus C9 round-trip)', () => {
	it('a branded factory store crosses the wire with its methods REBUILT', () => {
		// the target-repo house-factory shape: methods over a closure
		const createCounter = __og_store('test/counter.ts#store0', (seed: number = 0) => {
			const { subscribe, set, update } = writable(seed);
			return { subscribe, set, update, increment: () => update((n) => n + 1) };
		});

		const server_store = createCounter(5);
		expect(is_store(server_store)).toBe(true);

		const revived = dec(enc(server_store)) as ReturnType<typeof createCounter>;
		expect(get(revived as never)).toBe(5); // seed crossed
		revived.increment(); // method came from the FACTORY, not the wire
		expect(get(revived as never)).toBe(6);
	});

	it('a revived store is itself branded — it can cross a further boundary', () => {
		const make = __og_store('test/hop.ts#store0', (seed: string = '') => {
			const { subscribe, set } = writable(seed);
			return { subscribe, set, shout: () => `${seed}!` };
		});
		const hop1 = dec(enc(make('a'))) as ReturnType<typeof make>;
		const hop2 = dec(enc(hop1)) as ReturnType<typeof make>;
		expect(typeof hop2.shout).toBe('function');
	});

	it('registration happens at __og_store call time — decode works without ever calling the wrapped factory', () => {
		__og_store('test/lazy.ts#store0', (seed: number = 0) => {
			const { subscribe } = writable(seed);
			return { subscribe, tag: () => 'lazy' };
		});
		// simulate a payload minted by ANOTHER side: a store branded with the same tag, encoded here
		const { subscribe } = writable(7);
		const foreign = mark_store({ subscribe }, 'test/lazy.ts#store0');
		const revived = dec(enc(foreign)) as { tag: () => string };
		expect(revived.tag()).toBe('lazy'); // rebuilt THROUGH the registered factory
	});
});

describe('auto-brand tier (zero-authoring provable factories)', () => {
	const auto = (src: string, id = 'src/lib/s.ts') => auto_brand_stores(src, id, id, ['.svelte']);

	it('brands: expression body returning an object literal with subscribe', () => {
		const src = `export const createTabs = (i) => ({ subscribe: () => {}, active: i });`;
		expect(auto(src)).toContain(
			`__og_store("src/lib/s.ts#auto:createTabs", (i) => ({ subscribe: () => {}, active: i }))`
		);
	});

	it('brands: direct writable() with the svelte/store import; injects the runtime import', () => {
		const src = `import { writable } from 'svelte/store';\nexport const createCount = (n) => writable(n);`;
		const out = auto(src);
		expect(out).toContain(`import { __og_store } from 'ogygia/internal';`);
		expect(out).toContain(`__og_store("src/lib/s.ts#auto:createCount", (n) => writable(n))`);
	});

	it('brands: block body where EVERY return is provable', () => {
		const src = `import { writable } from 'svelte/store';\nexport const make = (seed) => {\n\tif (!seed) return writable(0);\n\tconst { subscribe, set } = writable(seed);\n\treturn { subscribe, set, reset: () => set(0) };\n};`;
		expect(auto(src)).toContain(`__og_store("src/lib/s.ts#auto:make"`);
	});

	it('SKIPS the ambiguous: call-result returns, mixed returns, local writable, non-export', () => {
		// returns a call result — unknowable shape
		expect(auto(`export const a = (s) => build(s);`)).toContain(
			'export const a = (s) => build(s);'
		);
		// a LOCAL function named writable must not count as proof
		const local = `function writable(n) { return n; }\nexport const b = (n) => writable(n);`;
		expect(auto(local)).toBe(local);
		// mixed returns
		const mixed = `import { writable } from 'svelte/store';\nexport const c = (n) => { if (n) return writable(n); return build(n); };`;
		expect(auto(mixed)).toBe(mixed);
		// not exported
		const priv = `const d = (n) => ({ subscribe: () => {} });`;
		expect(auto(priv)).toBe(priv);
	});

	it('nested functions returns do not count as the factory return', () => {
		// the factory's only real return is a call result; the inner arrow returning an object
		// with subscribe belongs to the INNER function — must not make the outer provable
		const src = `export const e = (n) => { const inner = () => ({ subscribe: 1 }); return build(inner); };`;
		expect(auto(src)).toBe(src);
	});

	it('auto-branded factory round-trips through the store kind with methods', () => {
		const src = `import { writable } from 'svelte/store';\nexport const createCtr = (seed = 0) => {\n\tconst { subscribe, set, update } = writable(seed);\n\treturn { subscribe, set, update, bump: () => update((n) => n + 1) };\n};`;
		const out = auto(src, 'src/lib/ctr.ts');
		// execute the branded module body against the real runtime
		const body = out
			.replace(`import { __og_store } from 'ogygia/internal';`, '')
			.replace(`import { writable } from 'svelte/store';`, '')
			.replace(/export const /g, 'globalThis.__ctr = ');
		new Function('__og_store', 'writable', body)(__og_store, writable);
		const createCtr = (globalThis as Record<string, unknown>).__ctr as (s?: number) => {
			bump: () => void;
		};
		const revived = dec(enc(createCtr(4))) as { bump: () => void };
		revived.bump();
		expect(get(revived as never)).toBe(5);
		delete (globalThis as Record<string, unknown>).__ctr;
	});
});

describe('og_derived — a derived that RESUMES across the boundary', () => {
	const encR = (v: unknown, fam = new Set(['store', 'fn', 'derived'])) =>
		stringify(v, { [REF_WIRE_KEY]: ref_reducer(fam) });
	const decR = (s: string) =>
		parse(s, { [REF_WIRE_KEY]: ref_reviver(true) as (d: never) => unknown });

	it("crosses ALIVE: bump the reunified source, every island's derived follows", () => {
		register_derived_kind();
		__register_fn('test/dd#$0', () => (n: number) => n * 2);
		const tally = writable(10);
		const doubled = og_derived(tally, fn_handle('test/dd#$0', []) as (n: never) => number);

		const payload = encR({ tally, doubled });
		const islandA = decR(payload) as { tally: typeof tally; doubled: typeof doubled };
		const islandB = decR(payload) as { tally: typeof tally; doubled: typeof doubled };

		expect(get(islandA.doubled as never)).toBe(20); // seeded exactly
		islandB.tally.set(21); // ← bump the SHARED live source from the other island
		expect(get(islandA.doubled as never)).toBe(42); // ✓ NOT frozen — resumed
	});

	it('multi-source recipe resumes too', () => {
		register_derived_kind();
		__register_fn('test/dd#$1', () => (vals: number[]) => vals[0] + vals[1]);
		const a = writable(1),
			b = writable(2);
		const sum = og_derived([a, b], fn_handle('test/dd#$1', []) as (v: never) => number);
		const out = decR(encR({ a, b, sum })) as { a: typeof a; sum: typeof sum };
		out.a.set(40);
		expect(get(out.sum as never)).toBe(42);
	});

	it('a PLAIN derived still freezes (the contrast the classifier warns about)', () => {
		const src = writable(5);
		const frozen = derived(src, (n) => n * 2);
		const out = decR(encR({ src, frozen })) as { src: typeof src; frozen: typeof frozen };
		out.src.set(100);
		expect(get(out.frozen as never)).toBe(10); // still the serialize-time snapshot
	});
});
