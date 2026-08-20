/**
 * THE BOUNDARY CORPUS — 21 cases from a real production migration target, as executable specs.
 *
 * Each case (C1–C21) mirrors internal/notes/boundary-corpus.md and models one anonymized
 * pattern found in a large SvelteKit codebase (178 setContext sites, 771 store singletons).
 * Built mechanisms are asserted; designed-but-unbuilt ones are `it.todo` — so this file is
 * the live progress checklist of the transportable seam.
 */
import { describe, it, expect } from 'vitest';
import { get, writable, readable, derived, readonly } from 'svelte/store';
import { parse, stringify } from 'devalue';
import {
	STORE_WIRE_KEY,
	reduce_store,
	revive_store,
	__register_store_factory,
	mark_store,
	is_store
} from '../src/store-transport.js';
import { classify_boundary } from '../src/boundary.js';
import { serialize_provided_context } from '../src/context-bridge.js';
import { set_ctx_recorder, record_ctx } from '../src/context-registry.js';
import { REF_WIRE_KEY, ref_reviver } from '../src/ref.js';

const enc = (v: unknown) => stringify(v, { [STORE_WIRE_KEY]: reduce_store });
const dec_client = (s: string) => parse(s, { [STORE_WIRE_KEY]: (d: never) => revive_store(d, true) });
const dec_server = (s: string) => parse(s, { [STORE_WIRE_KEY]: (d: never) => revive_store(d, false) });
const refusals = (v: unknown, key = '') => classify_boundary(v, key).filter((f) => f.kind === 'refuse');
const warns = (v: unknown, key = '') => classify_boundary(v, key).filter((f) => f.kind === 'warn');

// ─── Group 1 — plain data (crosses free) ────────────────────────────────────────

describe('Group 1: plain data', () => {
	it('C1: flags and strings cross byte-identical', () => {
		const ctx = { dir: 'rtl', disableSchema: true, datePublished: '2026-01-01' };
		expect(dec_client(enc(ctx))).toEqual(ctx);
		expect(refusals(ctx)).toEqual([]);
	});

	it('C2: server data objects/arrays (blocks, resolved links, layout props) cross', () => {
		const ctx = {
			mappedLinks: [{ originalUrl: '/a', resolvedUrl: '/b', invalid: false }],
			layoutProps: { country: 'fr', language: 'fr' },
			blocks: [{ id: 'blk-1', component: { name: 'Hero', options: { title: 'x' } } }]
		};
		expect(dec_client(enc(ctx))).toEqual(ctx);
	});

	it('C3: a DOM-DERIVED string (el.id) is still just a string — fine', () => {
		const ctx = { headingContext: { firstComponentId: 'section-hero-1' } };
		expect(dec_client(enc(ctx))).toEqual(ctx);
		expect(refusals(ctx)).toEqual([]);
	});

	it('C4: one object under two keys must not fork (identity holds through the wire)', () => {
		const block = { id: 'blk-1', options: { n: 1 } };
		const out = dec_client(enc({ a: block, b: { nested: block } })) as {
			a: object;
			b: { nested: object };
		};
		expect(out.a).toBe(out.b.nested); // devalue dedupes by reference
	});
});

// ─── Group 2 — same-island values (the granularity filter keeps them OFF the wire) ──

describe('Group 2: same-island (the explicit granularity marker: { islands: false })', () => {
	// Inference from getContext call-sites was REJECTED: `import { getContext as x }`, wrapper
	// modules, and custom context layers make any scan under-inclusive — and a missing key inside
	// an island is the fatal direction. The marker is explicit; the default bridges (safe).
	const record = (entries: Array<[string, unknown, { islands?: boolean }?]>) => {
		const bag = new Map<string, unknown>();
		set_ctx_recorder((k, v) => bag.set(k, v));
		for (const [k, v, opts] of entries) record_ctx(k, v, opts);
		set_ctx_recorder(null);
		return bag;
	};

	it('C5: DOM-ref stores + callbacks marked { islands: false } never reach the marker', () => {
		const bag = record([
			['scrollRefs', writable({ el: null }), { islands: false }],
			['dir', 'rtl'] // unmarked → bridges (default)
		]);
		expect(bag.has('scrollRefs')).toBe(false);
		expect(bag.get('dir')).toBe('rtl');
	});

	it('C6: a store holding an HTMLElement stays native via the marker', () => {
		const bag = record([['gallery', writable({ root: { nodeType: 1 } }), { islands: false }]]);
		expect(bag.size).toBe(0);
	});

	it('C7: default is BRIDGE — an unmarked key always records (missing-key is the fatal direction)', () => {
		const bag = record([['pageType', writable('standard')], ['closeModal', () => {}, { islands: false }]]);
		expect(bag.has('pageType')).toBe(true);
		expect(bag.has('closeModal')).toBe(false);
	});

	it('C5-guard: if a DOM-ref store DID cross unmarked, the classifier still refuses with a path', () => {
		const el = { nodeType: 1, nodeName: 'DIV' };
		const found = refusals({ refs: { scrollContainer: el } });
		expect(found[0]?.path).toBe('refs.scrollContainer');
		expect(found[0]?.detail).toMatch(/DOM node/);
	});
});

// ─── Group 3 — stores spanning islands (auto-wire + reunify) ────────────────────

describe('Group 3: store auto-wire', () => {
	it('C8: the symbol-keyed writable + readonly(getContext()) idiom — value crosses, islands share one live store', () => {
		// provider side: setContext(KEY, writable(v)) — the value that crosses:
		const provided = writable('standard');
		const payload = enc({ pageType: provided });
		// two islands decode the same marker:
		const a = (dec_client(payload) as { pageType: never }).pageType;
		const b = (dec_client(payload) as { pageType: never }).pageType;
		expect(a).toBe(b);
		// consumer side re-wraps in readonly() exactly like the source idiom:
		const view = readonly(a);
		(a as ReturnType<typeof writable>).set('landing');
		expect(get(view)).toBe('landing');
	});

	it('C9: the house factory (seed + grafted methods incl. browser-only ones) rebuilds via its registered factory', () => {
		function createStore<T>(seed: T) {
			const { subscribe, set, update } = writable(seed);
			return mark_store(
				{
					subscribe,
					set,
					update,
					// browser-only concern modeled: must exist after decode, not run at decode
					useLocalStorage: (key: string) => ({ key })
				},
				'corpus/house#createStore'
			);
		}
		__register_store_factory('corpus/house#createStore', createStore);

		const revived = dec_client(enc(createStore({ user: 'u1' }))) as ReturnType<typeof createStore>;
		expect(get(revived as never)).toEqual({ user: 'u1' });
		expect(revived.useLocalStorage('k')).toEqual({ key: 'k' }); // grafted method rebuilt
	});

	it('C10: a derived store crossing → loud warn (the derivation is lost), value still seeds', () => {
		const base = writable(2);
		const doubled = derived(base, (n) => n * 2);
		expect(warns({ doubled }).some((f) => /derivation/.test(f.detail))).toBe(true);
		// and the seed itself does cross:
		const revived = dec_client(enc({ doubled })) as { doubled: never };
		expect(get(revived.doubled)).toBe(4);
	});
});

// ─── Group 4 — mixed objects ─────────────────────────────────────────────────────

describe('Group 4: mixed objects', () => {
	it('C11: tabs context {store, id, onChange} — store wires, id crosses, onChange refuses (og.$ is the todo)', () => {
		const ctx = { tabsStore: writable(0), id: 'tabs-1', onChange: () => {} };
		const found = refusals(ctx);
		expect(found).toHaveLength(1);
		expect(found[0].path).toBe('onChange');
	});
	it.todo('C11b: og.$ hoists onChange (compile-visible closure → tagged module + bound captures)');

	it('C12: the mega-object (store + async network methods + DOM mutation) — every function path named', () => {
		const ctx = {
			buyStore: writable({ selectedId: null }),
			fetchProducts: async () => {},
			changeSelected: () => {}
		};
		const found = refusals(ctx);
		expect(found.map((f) => f.path).sort()).toEqual(['changeSelected', 'fetchProducts']);
	});
	it.todo('C12b: network methods migrate to remote functions; the DOM-mutating one stays same-island');

	it('C13: getter-grafted methods live in the MODULE — decode + re-graft, nothing lost', () => {
		// the source idiom: getX() returns {...readonly(store), add(), remove()}
		const inner = writable<string[]>([]);
		const payload = enc({ sections: inner });
		const revived = (dec_client(payload) as { sections: ReturnType<typeof writable<string[]>> }).sections;
		// consumer module re-grafts, exactly like the original getter:
		const grafted = {
			...readonly(revived),
			addSection: (s: string) => revived.update((x) => [...x, s])
		};
		grafted.addSection('intro');
		expect(get(revived)).toEqual(['intro']);
	});
});

// ─── Group 5 — genuinely can't cross (locate + refuse) ──────────────────────────

describe('Group 5: refusals', () => {
	it('C14: a DOM node in a crossing value → refuse with key+path', () => {
		const found = refusals({ ui: { root: { nodeType: 1, nodeName: 'DIV' } } }, 'gallery');
		expect(found[0].path).toBe('ui.root');
	});

	it('C15: cyclic class instance → refuse naming the class; cyclic PLAIN object is devalue-native', () => {
		class StepNode {
			next: StepNode | null = null;
		}
		const n = new StepNode();
		n.next = n;
		expect(refusals({ stepper: n })[0]?.detail).toMatch(/StepNode/);

		const plain: Record<string, unknown> = { id: 1 };
		plain.self = plain;
		expect(refusals({ plain })).toEqual([]);
		const out = dec_client(enc({ plain })) as { plain: Record<string, unknown> };
		expect(out.plain.self).toBe(out.plain);
	});

	it('C16: a secret-looking key → policy refusal (serializes fine, must not ship)', () => {
		expect(refusals('eyJhbGciOi...', 'emailToken')[0]?.detail).toMatch(/secret/);
		expect(refusals('sk_live_abc', 'apiKey')[0]?.detail).toMatch(/secret/);
	});

	it('C17: a side-effecting factory runs ONCE per handle on the client (reunify = no double listeners)', () => {
		let creations = 0;
		function createSized(seed: { width: number }) {
			creations++;
			const { subscribe, set } = writable(seed);
			return mark_store({ subscribe, set }, 'corpus/sized#createSized');
		}
		__register_store_factory('corpus/sized#createSized', createSized);
		const payload = enc(createSized({ width: 0 }));
		creations = 0; // ignore the server-side creation
		dec_client(payload);
		dec_client(payload); // second island, same handle
		expect(creations).toBe(1); // memoized by wire id — listeners can't double-register
	});

	it('C18: Map values cross (devalue-native); an opaque runtime handle refuses via the class check', () => {
		const ok = dec_client(enc({ colors: new Map([['red', '#f00']]) })) as { colors: Map<string, string> };
		expect(ok.colors.get('red')).toBe('#f00');

		class TimeoutHandle {} // models a live timer/socket handle in a store value
		expect(refusals({ t: new TimeoutHandle() })[0]?.detail).toMatch(/TimeoutHandle/);
	});
});

// ─── Group 6 — hazards islands expose ────────────────────────────────────────────

describe('Group 6: exposure hazards', () => {
	it('C19: the server NEVER reunites — each request decodes fresh (no cross-request bleed)', () => {
		const singleton = writable({ user: null });
		const payload = enc(singleton);
		expect(dec_server(payload)).not.toBe(dec_server(payload));
	});

	it('C20: same KEY, different store instances (layout vs page) stay distinct; same instance reunites', () => {
		const layout_user = writable({ id: 'u1' });
		const page_user = writable({ id: 'u1' }); // equal VALUE, different identity
		const out = dec_client(enc({ a: layout_user, b: page_user })) as { a: object; b: object };
		expect(out.a).not.toBe(out.b); // identity-keyed, not key/path-keyed
		const same = dec_client(enc({ a: layout_user, b: layout_user })) as { a: object; b: object };
		expect(same.a).toBe(same.b);
	});

	it.todo('C21: a dev warning when a context payload exceeds a size threshold');

	it('end-to-end: the page marker bridges a realistic mixed bag, dropping only the impossible', () => {
		const map = new Map<string, unknown>([
			['dir', 'rtl'], // C1
			['blocks', [{ id: 'b1' }]], // C2
			['pageType', writable('standard')], // C8
			['track', () => {}] // D-callback: dropped (og.$ is the future fix)
		]);
		const text = serialize_provided_context(map);
		const out = parse(text!, { [REF_WIRE_KEY]: ref_reviver(true) as (d: never) => unknown }) as Record<string, unknown>;
		expect(out.dir).toBe('rtl');
		expect(is_store(out.pageType)).toBe(true);
		expect('track' in out).toBe(false);
	});
});
