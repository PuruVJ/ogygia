/**
 * SEED REFERENCES (seed-refs.ts) — island props serialized relative to the page seed.
 *
 * Module level: the index (identity + structure), the reducer (largest matching ancestor, identity
 * before structure, exact comparison behind a hash hit, thresholds, cycles, non-plain values), the
 * client resolver + copy, and a real devalue round trip. Region level: inside Kit's page pass with
 * a tail and a seed on the way, props that are seed subtrees serialize as references; without a
 * seed, or outside the page pass, they stay full copies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'devalue';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import {
	SEED_REF_KEY,
	clone_plain,
	deep_equal_plain,
	index_seed,
	resolve_seed_ref,
	seed_ref_reducer,
	seed_ref_reviver
} from '../src/seed-refs.js';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';
import KitPagePass from './_fixtures/KitPagePass.svelte';
import { DocumentTail, set_tail_reader } from '../src/server/document-tail.js';
import { set_seed_wanted_reader } from '../src/page-seed-registry.js';
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
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

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

describe('seed_ref_reducer', () => {
	const data = { catalog: { blocks: [big('one'), big('two', 6)] }, greeting: 'hi' };
	const idx = index_seed(data);

	it('identity: the seed object itself → its path, largest ancestor wins, children untouched', () => {
		const props = { block: data.catalog.blocks[0], mode: 'identity' };
		const r = seed_ref_reducer(idx, props);
		expect(r(props.block)).toEqual(['catalog', 'blocks', 0]);
		expect(r(props.block.meta)).toBeUndefined(); // inside a matched ancestor: never written
		expect(r(props)).toBeUndefined(); // the props root is not a seed node
		expect(r('str')).toBeUndefined();
	});

	it('structure: a JSON clone of a seed node → the same path', () => {
		const props = { block: clone(data.catalog.blocks[1]) };
		const r = seed_ref_reducer(idx, props);
		expect(r(props.block)).toEqual(['catalog', 'blocks', 1]);
	});

	it('a near-clone (one field differs) does NOT match the parent, but its identical children do', () => {
		const near = { ...clone(data.catalog.blocks[1]), title: 'changed' };
		const r = seed_ref_reducer(idx, { block: near });
		expect(r(near)).toBeUndefined();
		expect(r(near.meta)).toEqual(['catalog', 'blocks', 1, 'meta']);
	});

	it('a value the seed does not have, or one below the threshold, is never referenced', () => {
		const props = { fresh: big('fresh'), small: { a: 1 } };
		const r = seed_ref_reducer(idx, props);
		expect(r(props.fresh)).toBeUndefined();
		expect(r(props.small)).toBeUndefined();
	});

	it('an empty index never references anything (and never walks the props)', () => {
		const r = seed_ref_reducer(index_seed({}), { block: data.catalog.blocks[0] });
		expect(r(data.catalog.blocks[0])).toBeUndefined();
	});

	it('devalue round trip: references replace the copies and revive to equal, OWN copies', () => {
		const props = { block: data.catalog.blocks[0], twin: clone(data.catalog.blocks[1]), n: 7 };
		const text = stringify(props, { [SEED_REF_KEY]: seed_ref_reducer(idx, props) });
		expect(text).toContain(SEED_REF_KEY);
		expect(text.length).toBeLessThan(stringify(props).length / 3);
		const revived = parse(text, { [SEED_REF_KEY]: seed_ref_reviver(() => data) }) as typeof props;
		expect(revived).toEqual(props);
		expect(revived.block).not.toBe(data.catalog.blocks[0]); // a copy — the island owns it
		revived.block.title = 'mutated';
		expect(data.catalog.blocks[0].title).toBe('one title');
	});
});

describe('resolve / clone', () => {
	it('resolves paths and copies plain data (Dates included); a missing path is undefined', () => {
		const data = { a: [{ d: new Date(5), s: new Set([1]) }] };
		expect(resolve_seed_ref(data, ['a', 0, 'd'])).toBe(data.a[0].d);
		expect(resolve_seed_ref(data, ['a', 9, 'd'])).toBeUndefined();
		expect(resolve_seed_ref(null, ['a'])).toBeUndefined();
		const c = clone_plain(data);
		expect(c).toEqual(data);
		expect(c).not.toBe(data);
		expect(c.a[0].d).not.toBe(data.a[0].d);
		expect(c.a[0].s).toBe(data.a[0].s); // non-plain: by reference
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
		for (const props of list) (region as unknown as (r: unknown, p: unknown) => void)(renderer, props);
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
	set_seed_wanted_reader(null);
	for (const k of Object.keys(page.data)) delete (page.data as Record<string, unknown>)[k];
});

describe('Region.svelte × seed references', () => {
	it('page pass + tail + seed wanted: a props subtree that is a seed node becomes a reference', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		set_seed_wanted_reader(() => true);
		Object.assign(page.data, { catalog: { blocks: [big('one'), big('two')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		render_in_kit_pass([
			island({ block: data.catalog.blocks[0] }), // identity
			island({ block: clone(data.catalog.blocks[1]) }) // clone
		]);
		const html = tail.render();
		expect(html.split(SEED_REF_KEY).length - 1).toBe(2);
		expect(html).not.toContain('one body');
		expect(html).not.toContain('two body');
		// and the reference revives to the block on the client side of the same codec
		const script = html.match(/data-ogygia-props="[0-9a-f]+">([^<]*)</)![1];
		const revived = parse(script, { [SEED_REF_KEY]: seed_ref_reviver(() => data) }) as { block: unknown };
		expect(revived.block).toEqual(data.catalog.blocks[0]);
	});

	it('seed NOT wanted (no $page reader on the page): full copies, never a reference', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		set_seed_wanted_reader(() => false);
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		render_in_kit_pass([island({ block: data.catalog.blocks[0] })]);
		const html = tail.render();
		expect(html).not.toContain(SEED_REF_KEY);
		expect(html).toContain('one body');
	});

	it('outside the page pass (a hole, a ticket, a test render): full copies even with a seed', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		set_seed_wanted_reader(() => true);
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		const data = page.data as { catalog: { blocks: ReturnType<typeof big>[] } };
		const out = render(region, { props: island({ block: data.catalog.blocks[0] }) });
		expect(out.body).not.toContain(SEED_REF_KEY);
		expect(out.body).toContain('one body');
	});

	it('props with no seed data in them serialize exactly as before', () => {
		tail = new DocumentTail();
		set_tail_reader(() => tail);
		set_seed_wanted_reader(() => true);
		Object.assign(page.data, { catalog: { blocks: [big('one')] } });
		render_in_kit_pass([island({ n: 1, label: 'plain' })]);
		expect(tail.render()).toContain('[{"n":1,"label":2},1,"plain"]');
	});
});
