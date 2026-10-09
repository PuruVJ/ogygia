/**
 * SEED REFERENCES (seed-refs.ts) — island props serialized relative to the page seed.
 *
 * Module level: the index (identity + structure), the plan (largest matching ancestor, identity
 * before structure, exact comparison behind a hash hit, thresholds, cycles, non-plain values), the
 * client resolver (by reference, lazy), and a real devalue round trip. Region level: inside Kit's page pass with
 * a tail, the tail renders against the seed index when the seed ships and props that are seed
 * subtrees serialize as references — whichever island rendered first; without a seed, or outside
 * the page pass, they stay full copies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'devalue';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import {
	SEED_REF_KEY,
	analyze,
	deep_equal_plain,
	index_seed,
	json_culprit,
	resolve_seed_ref,
	plan_seed_refs,
	seed_ref_reviver,
	set_measure_memo_reader,
	type MeasureMemo
} from '../src/seed-refs.js';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';
import KitPagePass from './_fixtures/KitPagePass.svelte';
import { DocumentTail, set_tail_reader } from '../src/server/document-tail.js';
import { page } from '$app/state';

const big = (label: string, n = 4) => ({
	id: label,
	title: `${label} title`,
	body: `${label} body `.repeat(n * 8),
	tags: ['a', 'b', label],
	meta: {
		weight: n,
		links: Array.from({ length: 8 }, (_, i) => ({ href: `/${label}/${i}`, label: `Link ${i}` }))
	}
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('index_seed', () => {
	it('indexes every referenceable node at or above the byte threshold, by identity and by hash', () => {
		const data = { catalog: { blocks: [big('one'), big('two')] }, tiny: { a: 1 } };
		const idx = index_seed(data);
		expect(idx.by_identity.get(data.catalog.blocks[0])).toEqual(['catalog', 'blocks', 0]);
		expect(idx.by_identity.get(data.catalog.blocks)).toEqual(['catalog', 'blocks']);
		expect(idx.by_identity.get(data.catalog)).toEqual(['catalog']);
		expect(idx.by_identity.has(data.tiny)).toBe(false); // below min_bytes
		expect(idx.size).toBeGreaterThan(3);
	});

	it('is cached per data object', () => {
		const data = { x: big('x') };
		expect(index_seed(data)).toBe(index_seed(data));
		expect(index_seed({ x: big('x') })).not.toBe(index_seed(data));
	});

	it('skips subtrees holding non-plain values (class instances, Maps, Sets) and cycles', () => {
		class Wired {
			v = 1;
		}
		const cyc: Record<string, unknown> = { id: 'c', body: 'x'.repeat(200) };
		cyc.self = cyc;
		const data = {
			withClass: { ...big('k'), w: new Wired(), inner: big('inner') },
			withMap: { ...big('m'), m: new Map([['a', 1]]) },
			cyc,
			ok: big('ok')
		};
		const idx = index_seed(data);
		expect(idx.by_identity.has(data.withClass)).toBe(false);
		expect(idx.by_identity.has(data.withMap)).toBe(false);
		expect(idx.by_identity.has(cyc)).toBe(false);
		expect(idx.by_identity.has(data.ok)).toBe(true);
		// the class-holding node's CLEAN children are still referenceable on their own
		expect(idx.by_identity.has(data.withClass.inner)).toBe(true);
		expect(idx.by_identity.has(data.withClass.meta)).toBe(true);
	});

	it('a non-object data (null, string) yields an empty index', () => {
		expect(index_seed(null).size).toBe(0);
		expect(index_seed('x').size).toBe(0);
	});
});

describe('plan_seed_refs', () => {
	const data = { catalog: { blocks: [big('one'), big('two', 6)] }, greeting: 'hi' };
	const idx = index_seed(data);

	it('identity: the seed object itself → its path, largest ancestor wins, children untouched', () => {
		const props = { block: data.catalog.blocks[0], mode: 'identity' };
		const { reducer: r, count } = plan_seed_refs(idx, props);
		expect(count).toBe(1);
		expect(r(props.block)).toEqual(['catalog', 'blocks', 0]);
		expect(r(props.block.meta)).toBeUndefined(); // inside a matched ancestor: never written
		expect(r(props)).toBeUndefined(); // the props root is not a seed node
		expect(r('str')).toBeUndefined();
	});

	it('structure: a JSON clone of a seed node → the same path', () => {
		const props = { block: clone(data.catalog.blocks[1]) };
		const { reducer: r, count } = plan_seed_refs(idx, props);
		expect(count).toBe(1);
		expect(r(props.block)).toEqual(['catalog', 'blocks', 1]);
	});

	it('a near-clone (one field differs) does NOT match the parent, but its identical children do', () => {
		const near = { ...clone(data.catalog.blocks[1]), title: 'changed' };
		const { reducer: r } = plan_seed_refs(idx, { block: near });
		expect(r(near)).toBeUndefined();
		expect(r(near.meta)).toEqual(['catalog', 'blocks', 1, 'meta']);
	});

	it('a value the seed does not have, or one below the threshold, is never referenced', () => {
		const props = { fresh: big('fresh'), small: { a: 1 } };
		const { reducer: r, count } = plan_seed_refs(idx, props);
		expect(count).toBe(0);
		expect(r(props.fresh)).toBeUndefined();
		expect(r(props.small)).toBeUndefined();
	});

	it('an empty index never references anything (and never walks the props)', () => {
		const { reducer: r, count } = plan_seed_refs(index_seed({}), { block: data.catalog.blocks[0] });
		expect(count).toBe(0);
		expect(r(data.catalog.blocks[0])).toBeUndefined();
	});

	it('devalue round trip: references replace the copies and revive BY REFERENCE to the seed nodes', () => {
		const props = { block: data.catalog.blocks[0], rest: clone(data.catalog.blocks[1]), n: 7 };
		const text = stringify(props, { [SEED_REF_KEY]: plan_seed_refs(idx, props).reducer });
		expect(text).toContain(SEED_REF_KEY);
		expect(text.length).toBeLessThan(stringify(props).length / 3);
		let reads = 0;
		const revived = parse(text, {
			[SEED_REF_KEY]: seed_ref_reviver(() => (reads++, data))
		}) as typeof props;
		expect(revived).toEqual(props);
		// BY REFERENCE: the island gets the seed's own node (the same object its `page.data` read
		// would hand it), and the seed was resolved exactly once for the whole sidecar.
		expect(revived.block).toBe(data.catalog.blocks[0]);
		expect(revived.rest).toBe(data.catalog.blocks[1]);
		expect(reads).toBe(1);
	});

	it('the reviver resolves the seed lazily — never when the sidecar carries no reference', () => {
		let reads = 0;
		const revived = parse(stringify({ plain: [1, 2] }), {
			[SEED_REF_KEY]: seed_ref_reviver(() => (reads++, {}))
		});
		expect(revived).toEqual({ plain: [1, 2] });
		expect(reads).toBe(0);
	});
});

// ONE WALK PER NODE PER REQUEST: with the request memo installed (hooks.ts does), a props object
// that is a seed node is a lookup — the memo does not grow by the block's subtree again — and the
// index prunes below the threshold: no path array exists until a reference is planned.
describe('the shared request memo', () => {
	afterEach(() => set_measure_memo_reader(null));

	it('a block island whose props are a seed node adds one entry (its wrapper), not a subtree', () => {
		const memo: MeasureMemo = new Map();
		set_measure_memo_reader(() => memo);
		const data = { catalog: { blocks: Array.from({ length: 20 }, (_, i) => big(`b${i}`)) } };
		const idx = index_seed(data);
		const after_seed = memo.size;
		expect(after_seed).toBeGreaterThan(20 * 3); // blocks, metas, link objects…
		for (const block of data.catalog.blocks) {
			const props = { block };
			expect(analyze(props).json).toBe(true);
			expect(plan_seed_refs(idx, props).count).toBe(1);
		}
		expect(memo.size).toBe(after_seed + 20); // exactly the twenty `{ block }` wrappers
		// a shaped copy of the seed (new root, same children) is a handful of lookups too
		const shaped = { catalog: data.catalog };
		expect(analyze(shaped).bytes).toBe(analyze(data).bytes);
		expect(memo.size).toBe(after_seed + 21);
	});

	it('without a reader every root measures on its own (a hole endpoint, a test)', () => {
		const data = { x: big('x') };
		expect(analyze({ x: data.x }).ref).toBe(true);
		expect(index_seed(data).by_identity.get(data.x)).toEqual(['x']);
	});

	it('a cycle met through the shared memo is opaque, and the walk still terminates', () => {
		const memo: MeasureMemo = new Map();
		set_measure_memo_reader(() => memo);
		const cyc: Record<string, unknown> = { body: 'x'.repeat(200) };
		cyc.self = cyc;
		expect(analyze({ cyc })).toMatchObject({ ref: false, json: false });
		expect(analyze({ again: cyc })).toMatchObject({ ref: false, json: false });
		expect(index_seed({ cyc }).by_identity.has(cyc)).toBe(false);
	});
});

describe('json_culprit (why a tree left the JSON lane)', () => {
	it('names the first disqualifying leaf with its path and kind', () => {
		expect(json_culprit({ a: 1, b: [{ c: 'x' }] })).toBeNull();
		expect(json_culprit({ config: { updated: new Date(0) } })).toBe('config.updated (Date)');
		expect(json_culprit({ rows: [1, NaN] })).toBe('rows[1] (NaN)');
		expect(json_culprit({ rows: [1, undefined] })).toBe('rows[1] (undefined in array)');
		expect(json_culprit({ gone: undefined, ok: 1 })).toBeNull(); // an undefined PROPERTY is fine
		expect(json_culprit({ facets: new Map() })).toBe('facets (Map)');
		expect(json_culprit({ n: 1n })).toBe('n (bigint)');
		class Foo {}
		expect(json_culprit({ meta: new Foo() })).toBe('meta (class Foo)');
		expect(json_culprit({ x: { [Symbol.for('ogygia.brand')]: true } })).toBe('x (symbol-branded)');
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(json_culprit({ cyc })).toBe('cyc.self (cycle)');
		expect(json_culprit(new Date(0))).toBe('(root) (Date)');
	});

	it('the plan reports which top-level keys its references point into', () => {
		const data = { catalog: { blocks: [big('one')] }, other: big('two') };
		const idx = index_seed(data);
		const plan = plan_seed_refs(idx, { a: data.catalog.blocks[0], b: data.other, c: 1 });
		expect(plan.count).toBe(2);
		expect([...plan.keys].sort()).toEqual(['catalog', 'other']);
	});
});

describe('resolve', () => {
	it('resolves paths; a missing path is undefined', () => {
		const data = { a: [{ d: new Date(5), s: new Set([1]) }] };
		expect(resolve_seed_ref(data, ['a', 0, 'd'])).toBe(data.a[0].d);
		expect(resolve_seed_ref(data, ['a', 9, 'd'])).toBeUndefined();
		expect(resolve_seed_ref(null, ['a'])).toBeUndefined();
	});

	it('deep_equal_plain: exact structural equality only', () => {
		expect(deep_equal_plain(big('x'), clone(big('x')))).toBe(true);
		expect(deep_equal_plain(big('x'), big('y'))).toBe(false);
		expect(deep_equal_plain({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
		expect(deep_equal_plain({ a: 1 }, { a: 1, b: undefined })).toBe(false);
		expect(deep_equal_plain(new Date(1), new Date(1))).toBe(true);
	});
});

// ───────────────────────────────────────────── Region.svelte × the seed ──
const region = Region as unknown as Component<Record<string, unknown>>;
const kit_pass = KitPagePass as unknown as Component<Record<string, unknown>>;

function render_in_kit_pass(list: Array<Record<string, unknown>>) {
	const children = (renderer: { push(html: string): void }) => {
		for (const props of list)
			(region as unknown as (r: unknown, p: unknown) => void)(renderer, props);
	};
	// `render()`'s body is LAZY — read it, or nothing renders
	const out = render(kit_pass, { props: { children } });
	void out.body;
	return out;
}
const island = (props: Record<string, unknown>) => ({
	__mode: 'island',
	__entry: '/islands/tiny.js',
	__component: Tiny,
	__props: props,
	load: true
});

let tail: DocumentTail;
afterEach(() => {
	set_tail_reader(null);
	for (const k of Object.keys(page.data)) delete (page.data as Record<string, unknown>)[k];
});

describe('Region.svelte × seed references', () => {
	it('page pass + tail rendered against the seed: a props subtree that is a seed node becomes a reference', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		Object.assign(page.data, { catalog: { blocks: [big('one'), big('two')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		render_in_kit_pass([
			island({ block: data.catalog.blocks[0] }), // identity
			island({ block: clone(data.catalog.blocks[1]) }) // clone
		]);
		const html = tail.render(index_seed(data));
		expect(html.split(SEED_REF_KEY).length - 1).toBe(2);
		expect(html).not.toContain('one body');
		expect(html).not.toContain('two body');
		// and the reference revives to the block on the client side of the same codec
		const script = html.match(/data-ogygia-props="[0-9a-f]+" id="[^"]+">([^<]*)</)![1];
		const revived = parse(script, { [SEED_REF_KEY]: seed_ref_reviver(() => data) }) as {
			block: unknown;
		};
		expect(revived.block).toEqual(data.catalog.blocks[0]);
	});

	it('the FIRST island on the page references too (the decision is made when the tail renders)', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		// one island, rendered before anything could have asked for the seed
		render_in_kit_pass([island({ block: data.catalog.blocks[0] })]);
		const html = tail.render(index_seed(data));
		expect(html.split(SEED_REF_KEY).length - 1).toBe(1);
		expect(html).not.toContain('one body');
	});

	it('the fingerprint does not depend on the seed: same island, referenced or copied → same data-og-fp', () => {
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		const fp_of = (out: { body: string }) => out.body.match(/data-og-fp="([0-9a-f]+)"/)![1];
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		const a = render_in_kit_pass([island({ block: data.catalog.blocks[0] })]);
		expect(tail.render(index_seed(data))).toContain(SEED_REF_KEY);
		tail = new DocumentTail();
		const b = render_in_kit_pass([island({ block: data.catalog.blocks[0] })]);
		expect(tail.render(null)).not.toContain(SEED_REF_KEY);
		expect(fp_of(a)).toBe(fp_of(b));
	});

	it('seed NOT shipped (no $page reader on the page): full copies, never a reference', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		render_in_kit_pass([island({ block: data.catalog.blocks[0] })]);
		const html = tail.render(null);
		expect(html).not.toContain(SEED_REF_KEY);
		expect(html).toContain('one body');
	});

	it('outside the page pass (a hole, a ticket, a test render): full copies even with a seed', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		const out = render(region, { props: island({ block: data.catalog.blocks[0] }) });
		expect(out.body).not.toContain(SEED_REF_KEY);
		expect(out.body).toContain('one body');
	});

	it('plain props with no seed data in them take the JSON lane', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		render_in_kit_pass([island({ n: 1, label: 'plain' })]);
		const html = tail.render(index_seed(page.data));
		expect(html).toContain('data-og-format="json"');
		expect(html).toContain('>{"n":1,"label":"plain"}<');
	});
});
