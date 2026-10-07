// Holes that start fetching in the same task go out as ONE batch POST (runtime/frame-nav.ts
// `join_batch`); a lone hole and a hole whose request the HTML already started (its parse-time
// `<link rel="preload" as="fetch">`) do not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join_batch } from '../../src/runtime/frame-nav.js';
import { _reset, ensure, peek } from '../../src/runtime/frame-store.js';
import { frameAddress } from '../../src/frame.js';
import { build_parcel, done_parcel } from '../../src/server/stream-regions.js';

// (the address is the call — id + props — so each hole gets its own props)
const ep = (sig: string) => `/__ogygia__?id=aaaaaaaaaaaa&props=${sig}&exp=9999999999&sig=${sig}`;

function stub_batch(answer: (calls: string[]) => string) {
	const posts: string[][] = [];
	const spy = vi.spyOn(window, 'fetch').mockImplementation(async (_url, init) => {
		const calls = JSON.parse(String(init?.body)) as string[];
		posts.push(calls);
		await new Promise((r) => setTimeout(r, 20)); // (a network: the holes join before it answers)
		return new Response(answer(calls), { status: 200, headers: { 'content-type': 'text/html' } });
	});
	return { posts, spy };
}

afterEach(() => {
	vi.restoreAllMocks();
	_reset();
	for (const l of document.head.querySelectorAll('link[data-test-hint]')) l.remove();
});

describe('join_batch', () => {
	it('two holes in one task: one POST, and each fetch joins it', async () => {
		const { posts } = stub_batch((calls) =>
			calls.map((c) => build_parcel(new URL(c, location.href).searchParams.get('sig')!, `<p>${c.slice(-1)}</p>`)).join('') + done_parcel()
		);
		const own = vi.fn(async () => 'own');
		await Promise.all([join_batch(ep('s1')), join_batch(ep('s2'))]);
		const [a, b] = await Promise.all([ensure(frameAddress(ep('s1')), own), ensure(frameAddress(ep('s2')), own)]);
		expect(posts).toEqual([[ep('s1'), ep('s2')]]);
		expect(own).not.toHaveBeenCalled();
		expect([a, b]).toEqual(['<p>1</p>', '<p>2</p>']);
	});

	it('a lone hole goes on its own', async () => {
		const { posts } = stub_batch(() => done_parcel());
		await join_batch(ep('solo'));
		expect(posts).toEqual([]);
	});

	it('a hole whose request the HTML started is left out', async () => {
		const { posts } = stub_batch(() => done_parcel());
		const link = document.createElement('link');
		link.rel = 'preload';
		link.as = 'fetch';
		link.setAttribute('href', ep('h1'));
		link.setAttribute('data-test-hint', '');
		document.head.append(link);
		await Promise.all([join_batch(ep('h1')), join_batch(ep('h2'))]);
		expect(posts).toEqual([]); // one left: it goes alone
	});

	it('a preload whose href is relative still matches the pinned root-absolute endpoint', async () => {
		// REGRESSION (field report on 0069b94b): the page pins a region's endpoint root-absolute while
		// the link kept its relative text, the strings never matched, and the hole went in the batch
		// beside its own preload: its HTML downloaded twice
		const { posts } = stub_batch(() => done_parcel());
		const pinned = new URL(ep('r1'), location.href);
		const dir = location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1);
		let rel = '';
		for (let i = 1; i < dir.split('/').length - 1; i++) rel += '../';
		const link = document.createElement('link');
		link.rel = 'preload';
		link.as = 'fetch';
		link.setAttribute('href', (rel || './') + pinned.pathname.slice(1) + pinned.search);
		link.setAttribute('data-test-hint', '');
		document.head.append(link);
		expect(link.getAttribute('href')).not.toBe(ep('r1'));
		expect(link.href).toBe(pinned.href);
		await Promise.all([join_batch(ep('r1')), join_batch(ep('r2'))]);
		expect(posts).toEqual([]);
	});

	it('a frame the batch did not carry: the joined fetch rejects as a batch miss', async () => {
		stub_batch(() => done_parcel());
		await Promise.all([join_batch(ep('m1')), join_batch(ep('m2'))]);
		const err = await ensure(frameAddress(ep('m1')), async () => 'own').catch((e) => e);
		expect(err?.name).toBe('OgygiaBatchMiss');
		expect(peek(frameAddress(ep('m1')))).toBeNull();
	});
});
