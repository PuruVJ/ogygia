/**
 * The transportable-seam conformance suite.
 *
 * Cases are drawn from a census of a real large SvelteKit app (178 setContext sites, 771
 * store singletons) — each test models one pattern found there, so this suite IS the
 * migration contract: what auto-wires, what warns, what refuses (and how precisely).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get, writable, derived, readonly } from 'svelte/store';
import { parse, stringify } from 'devalue';
import {
	STORE_WIRE_KEY,
	reduce_store,
	revive_store,
	__register_store_factory,
	mark_store,
	is_store
} from '../src/store-transport.js';
import { classify_boundary, boundary_problems } from '../src/boundary.js';
import { serialize_provided_context, serialize_context } from '../src/context-bridge.js';
import { REF_WIRE_KEY, ref_reviver } from '../src/ref.js';

/** The seams now emit ONE hub key — parse their output the way an island does. */
const parse_seam = (text: string) =>
	parse(text, { [REF_WIRE_KEY]: ref_reviver(true) as (d: never) => unknown }) as Record<
		string,
		unknown
	>;

/** Round-trip helpers: server encode → client decode (remember) / server decode (fresh). */
const enc = (v: unknown) => stringify(v, { [STORE_WIRE_KEY]: reduce_store });
const dec_client = (s: string) =>
	parse(s, { [STORE_WIRE_KEY]: (d: never) => revive_store(d, true) });
const dec_server = (s: string) =>
	parse(s, { [STORE_WIRE_KEY]: (d: never) => revive_store(d, false) });

/** The registries live on globalThis — flush the live map between tests via fresh ids
 *  (each test creates fresh stores, so ids never collide; nothing to reset). */

// ─── Group 1: plain data crosses free (census C1–C4) ────────────────────────────

describe('plain data', () => {
	it('strings / booleans / objects / arrays cross byte-identical', () => {
		const value = { dir: 'rtl', disableFaq: true, blocks: [{ id: 'b1', opts: { n: 1 } }] };
		expect(dec_client(enc(value))).toEqual(value);
	});

	it('Map and Set cross via devalue natively (census C18)', () => {
		const value = { colors: new Map([['red', '#f00']]), tags: new Set(['a']) };
		const out = dec_client(enc(value)) as typeof value;
		expect(out.colors.get('red')).toBe('#f00');
		expect(out.tags.has('a')).toBe(true);
	});
});

// ─── Group 3: stores auto-wire + reunify (census C8, C9, C13) ───────────────────

describe('store auto-wire', () => {
	it('a bare writable crosses: value survives, client store is live', () => {
		const server_store = writable({ count: 1 });
		const revived = dec_client(enc(server_store)) as ReturnType<typeof writable>;
		expect(is_store(revived)).toBe(true);
		expect(get(revived)).toEqual({ count: 1 });
		revived.set({ count: 2 });
		expect(get(revived)).toEqual({ count: 2 });
	});

	it('REUNIFICATION: two islands decoding the same handle share ONE live store (C8)', () => {
		const server_store = writable('dark');
		const payload = enc({ theme: server_store });
		const island_a = (dec_client(payload) as { theme: ReturnType<typeof writable> }).theme;
		const island_b = (dec_client(payload) as { theme: ReturnType<typeof writable> }).theme;
		expect(island_a).toBe(island_b); // same instance, not equal copies
		island_a.set('light');
		expect(get(island_b)).toBe('light'); // A's set repaints B
	});

	it('IDENTITY DEDUPE: one store under two context keys stays ONE instance (C4/C20 trap)', () => {
		const cart = writable(['sku1']);
		const payload = enc({ cart, checkout: { cart } });
		const out = dec_client(payload) as { cart: object; checkout: { cart: object } };
		expect(out.cart).toBe(out.checkout.cart); // path-keyed ids would fork this
	});

	it('SERVER ISOLATION: remember:false decodes fresh per request', () => {
		const s = writable(0);
		const payload = enc(s);
		const req1 = dec_server(payload);
		const req2 = dec_server(payload);
		expect(req1).not.toBe(req2); // per-request isolation, like wire classes
	});

	it('registered factory rebuilds custom methods (createWritableStore pattern, C9)', () => {
		// the target repo's house factory: methods over a closure
		function createCounter(seed = 0) {
			const { subscribe, set, update } = writable(seed);
			return mark_store(
				{ subscribe, set, update, increment: () => update((n) => n + 1) },
				'test/counter#createCounter'
			);
		}
		__register_store_factory('test/counter#createCounter', createCounter);

		const server_store = createCounter(5);
		const revived = dec_client(enc(server_store)) as ReturnType<typeof createCounter>;
		expect(get(revived)).toBe(5); // seed crossed
		revived.increment(); // method REBUILT from the factory, not serialized
		expect(get(revived)).toBe(6);
	});

	it('unregistered factory tag DEGRADES to a plain writable (graceful floor) with a warning', () => {
		const s = mark_store(writable(1), 'test/ghost#neverRegistered');
		const warns: string[] = [];
		const orig = console.warn;
		console.warn = (m: string) => void warns.push(String(m));
		try {
			const revived = dec_client(enc(s));
			expect(is_store(revived)).toBe(true); // value crossed, set/subscribe work
			expect(get(revived as never)).toBe(1);
			expect(warns.some((w) => /factory not loaded/.test(w))).toBe(true);
		} finally {
			console.warn = orig;
		}
	});

	it('unbranded custom store degrades to a plain writable (generic tier)', () => {
		const { subscribe, set, update } = writable([1]);
		const custom = { subscribe, set, update, reset: () => set([]) };
		const revived = dec_client(enc(custom)) as Record<string, unknown>;
		expect(get(revived as never)).toEqual([1]); // value survives
		expect(revived.reset).toBeUndefined(); // bespoke method does not (classifier warns)
	});
});

// ─── The classifier: warn/refuse with paths (census C10, C14–C16, D) ───────────

describe('boundary classifier', () => {
	it('derived store → warn (seeding loses the derivation, C10)', () => {
		const base = writable(2);
		const doubled = derived(base, (n) => n * 2);
		const findings = classify_boundary({ doubled });
		expect(
			findings.some((f) => f.kind === 'warn' && f.path === 'doubled' && /derivation/.test(f.detail))
		).toBe(true);
	});

	it('readonly() wrapper → warn like derived (builder-tc getter pattern, C8 consumer)', () => {
		const findings = classify_boundary(readonly(writable(1)));
		expect(findings.some((f) => f.kind === 'warn' && /derived|frozen/i.test(f.detail))).toBe(true);
	});

	it('store with custom methods but no factory → warn NAMING the methods (C9/C13)', () => {
		const { subscribe, set, update } = writable(0);
		const findings = classify_boundary({
			counter: { subscribe, set, update, increment() {}, reset() {} }
		});
		const warn = findings.find((f) => f.kind === 'warn' && f.path === 'counter');
		expect(warn?.detail).toMatch(/increment/);
		expect(warn?.detail).toMatch(/reset/);
	});

	it('bare function → refuse with the fix options (census D: trackPageView)', () => {
		const findings = classify_boundary({ trackPageView: () => {} });
		const refusal = findings.find((f) => f.kind === 'refuse');
		expect(refusal?.path).toBe('trackPageView');
		expect(refusal?.detail).toMatch(/remote function|og\.wire|island/);
	});

	it('live DOM node → refuse with path (census C14: menubar/carousel refs)', () => {
		const fake_el = { nodeType: 1, nodeName: 'DIV' }; // DOM shape without a browser
		const findings = classify_boundary({ ui: { root: fake_el } });
		const refusal = findings.find((f) => f.kind === 'refuse');
		expect(refusal?.path).toBe('ui.root');
		expect(refusal?.detail).toMatch(/DOM node/);
	});

	it('cyclic PLAIN object is fine (devalue-native); cyclic CLASS instance refuses (C15)', () => {
		// plain-object cycle: devalue serializes it natively — no refusal, and it round-trips
		const node: Record<string, unknown> = { id: 'step1' };
		node.self = node;
		expect(classify_boundary({ stepper: node }).some((f) => f.kind === 'refuse')).toBe(false);
		const out = dec_client(enc({ stepper: node })) as { stepper: Record<string, unknown> };
		expect(out.stepper.self).toBe(out.stepper);

		// class-instance cycle (linked list with next/prev): the class check refuses it
		class StepNode {
			next: StepNode | null = null;
		}
		const a = new StepNode();
		a.next = a;
		const findings = classify_boundary({ stepper: a });
		expect(findings.some((f) => f.kind === 'refuse' && /StepNode/.test(f.detail))).toBe(true);
	});

	it('secret-looking key → refuse (census C16: emailToken in context)', () => {
		const findings = classify_boundary('eyJhbGciOi...', 'emailToken');
		expect(findings.some((f) => f.kind === 'refuse' && /secret/.test(f.detail))).toBe(true);
	});

	it('unwired class instance → refuse naming the class', () => {
		class LinkedList {
			head = null;
		}
		const findings = classify_boundary({ list: new LinkedList() });
		const refusal = findings.find((f) => f.kind === 'refuse');
		expect(refusal?.path).toBe('list');
		expect(refusal?.detail).toMatch(/LinkedList/);
		expect(refusal?.detail).toMatch(/og\.wire/);
	});

	it('clean values produce no problems', () => {
		expect(boundary_problems({ dir: 'rtl', n: 1, store: writable(0) })).toEqual([]);
	});
});

// ─── The context bridge path end-to-end (the drop-in setContext marker) ────────

describe('serialize_provided_context (the page marker)', () => {
	it('bridges plain data and stores; drops functions; keeps the rest (mixed bag)', () => {
		const map = new Map<string, unknown>([
			['currentDir', 'rtl'], // census C1
			['theme', writable('dark')], // census C8
			['trackPageView', () => {}] // census D — must drop, not crash
		]);
		const text = serialize_provided_context(map);
		expect(text).not.toBeNull();
		const out = parse_seam(text!);
		expect(out.currentDir).toBe('rtl');
		expect(is_store(out.theme)).toBe(true);
		expect(get(out.theme as never)).toBe('dark');
		expect('trackPageView' in out).toBe(false); // dropped, page still bridges
	});

	it('returns null when nothing can bridge', () => {
		expect(serialize_provided_context(new Map([['fn', () => {}]]))).toBeNull();
	});

	it('serialize_context (Provide path) carries stores too', () => {
		const text = serialize_context({ count: writable(3) });
		const out = parse_seam(text) as { count: never };
		expect(get(out.count)).toBe(3);
	});
});
