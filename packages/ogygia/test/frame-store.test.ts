import { afterEach, describe, expect, it, vi } from 'vitest';
import * as frames from '../src/runtime/frame-store.js';

afterEach(() => frames._reset());

/** A fetcher whose resolution you control, and that records whether it was aborted. */
function deferred(html = 'HTML') {
	let resolve!: (v: string) => void;
	let reject!: (e: unknown) => void;
	let aborted = false;
	const p = new Promise<string>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const fetcher = (signal: AbortSignal) => {
		signal.addEventListener('abort', () => (aborted = true));
		return p;
	};
	return {
		fetcher,
		resolve: (v = html) => resolve(v),
		reject: (e: unknown = new Error('boom')) => reject(e),
		get aborted() {
			return aborted;
		}
	};
}

describe('frame-store: dedupe', () => {
	it('N callers on the same address share ONE fetch', async () => {
		const d = deferred('X');
		const spy = vi.fn(d.fetcher);
		const a = frames.ensure('/r?sig=1', spy);
		const b = frames.ensure('/r?sig=1', spy);
		const c = frames.ensure('/r?sig=1', spy);
		expect(spy).toHaveBeenCalledTimes(1);
		d.resolve('X');
		expect(await Promise.all([a, b, c])).toEqual(['X', 'X', 'X']);
	});

	it('different addresses fetch independently', () => {
		const spy = vi.fn(deferred().fetcher);
		frames.ensure('/r?sig=1', spy);
		frames.ensure('/r?sig=2', spy);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('resolved content is reused without refetching', async () => {
		const d = deferred('ONE');
		const spy = vi.fn(d.fetcher);
		const first = frames.ensure('/r?sig=1', spy);
		d.resolve('ONE');
		await first;
		const again = await frames.ensure('/r?sig=1', vi.fn());
		expect(again).toBe('ONE');
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe('frame-store: staleness', () => {
	it('drops a write older than what was applied', () => {
		expect(frames.write({ a: '/x', v: 5, html: 'new' })).toBe(true);
		expect(frames.write({ a: '/x', v: 3, html: 'old' })).toBe(false);
		expect(frames.peek('/x')).toEqual({ v: 5, html: 'new' });
	});

	it('a slow response that started earlier cannot overwrite a newer one', async () => {
		// Two forced fetches race; the SECOND to start gets the higher ticket. The FIRST resolves last
		// but must not clobber, because its ticket is lower.
		const slow = deferred('SLOW-old');
		const fast = deferred('FAST-new');
		const pSlow = frames.ensure('/r?sig=1', slow.fetcher, { force: true }); // ticket 1
		const pFast = frames.ensure('/r?sig=1', fast.fetcher, { force: true }); // ticket 2
		fast.resolve('FAST-new'); // ticket 2 applies
		await pFast;
		expect(frames.peek('/r?sig=1')?.html).toBe('FAST-new');
		slow.resolve('SLOW-old'); // ticket 1 arrives late — dropped
		await pSlow;
		expect(frames.peek('/r?sig=1')?.html).toBe('FAST-new');
	});
});

describe('frame-store: lifecycle', () => {
	it('abandon aborts the fetch only when the LAST waiter leaves', () => {
		const d = deferred();
		frames.ensure('/r?sig=1', d.fetcher); // waiters: 1
		frames.ensure('/r?sig=1', d.fetcher); // waiters: 2 (deduped)
		frames.abandon('/r?sig=1');
		expect(d.aborted).toBe(false); // one waiter still there
		frames.abandon('/r?sig=1');
		expect(d.aborted).toBe(true); // last one out
	});

	it('a rejected fetch propagates to every joined caller and clears in-flight', async () => {
		const d = deferred();
		const a = frames.ensure('/r?sig=1', d.fetcher);
		const b = frames.ensure('/r?sig=1', d.fetcher);
		d.reject(new Error('net'));
		await expect(a).rejects.toThrow('net');
		await expect(b).rejects.toThrow('net');
		// A later ensure starts a fresh fetch (in-flight was cleared on failure).
		const spy = vi.fn(deferred('RETRY').fetcher);
		frames.ensure('/r?sig=1', spy);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('subscribers are notified on apply and stop after unsubscribe', () => {
		const seen: string[] = [];
		const off = frames.subscribe('/x', (f) => seen.push(f.html));
		frames.write({ a: '/x', v: 1, html: 'a' });
		frames.write({ a: '/x', v: 2, html: 'b' });
		off();
		frames.write({ a: '/x', v: 3, html: 'c' });
		expect(seen).toEqual(['a', 'b']);
	});
});

describe('frame-store: eviction (no leak)', () => {
	afterEach(() => vi.useRealTimers());

	it('a write with NO subscriber evicts after the TTL (orphan writes do not leak)', () => {
		vi.useFakeTimers();
		// A single-flight mutation (or a live tick whose address changes) writes an address nothing is
		// bound to. It must not linger forever — nothing ever subscribes to trigger cleanup.
		frames.write({ a: '/orphan', v: 1, html: 'x' });
		expect(frames.peek('/orphan')).toEqual({ v: 1, html: 'x' }); // still here for a late binder
		vi.advanceTimersByTime(60_000);
		expect(frames.peek('/orphan')).toBeNull(); // dropped
	});

	it('a late binder within the TTL window still catches an unbound write (prefetch semantics)', () => {
		vi.useFakeTimers();
		frames.write({ a: '/warm', v: 1, html: 'seeded' });
		vi.advanceTimersByTime(30_000); // half the window
		const seen: string[] = [];
		frames.subscribe('/warm', (f) => seen.push(f.html)); // mounts late — replays current content
		expect(seen).toEqual(['seeded']);
		vi.advanceTimersByTime(60_000); // subscribing cancelled the evict; still held while bound
		expect(frames.peek('/warm')).toEqual({ v: 1, html: 'seeded' });
	});

	it('a subscribed address is NOT evicted by its own writes', () => {
		vi.useFakeTimers();
		frames.subscribe('/live', () => {});
		frames.write({ a: '/live', v: 1, html: 'a' });
		frames.write({ a: '/live', v: 2, html: 'b' });
		vi.advanceTimersByTime(120_000);
		expect(frames.peek('/live')).toEqual({ v: 2, html: 'b' }); // bound → kept
	});
});

describe('frame-store: reservation (single-flight navigation)', () => {
	it('ensure() JOINS a reservation instead of fetching; write() fulfils it', async () => {
		// A batch reserves the address before the binder connects. The binder's ensure() must NOT fetch.
		frames.reserve('/r?sig=1');
		const spy = vi.fn(deferred().fetcher);
		const joined = frames.ensure('/r?sig=1', spy);
		expect(spy).not.toHaveBeenCalled(); // joined the batch — no per-region fetch
		frames.write({ a: '/r?sig=1', v: 5, html: 'FROM-BATCH' }); // frame lands
		expect(await joined).toBe('FROM-BATCH');
		expect(frames.peek('/r?sig=1')).toEqual({ v: 5, html: 'FROM-BATCH' });
	});

	it('release() fails an undelivered reservation so the binder falls back to its own fetch', async () => {
		frames.reserve('/r?sig=1');
		const joined = frames.ensure('/r?sig=1', vi.fn());
		frames.release('/r?sig=1'); // batch ended, no frame for this address
		await expect(joined).rejects.toThrow(/no frame/);
		// A fresh ensure now starts a real fetch (reservation cleared).
		const spy = vi.fn(deferred('LATE').fetcher);
		frames.ensure('/r?sig=1', spy);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('release() is a no-op once the frame has landed', () => {
		frames.reserve('/r?sig=1');
		frames.write({ a: '/r?sig=1', v: 1, html: 'HAVE-IT' });
		frames.release('/r?sig=1'); // must not clobber delivered content
		expect(frames.peek('/r?sig=1')).toEqual({ v: 1, html: 'HAVE-IT' });
	});

	it('reserve() is a no-op when content or a fetch is already present', () => {
		frames.write({ a: '/have', v: 1, html: 'x' });
		frames.reserve('/have'); // has content — nothing to reserve
		const spy = vi.fn(deferred('Y').fetcher);
		void frames.ensure('/have', spy);
		expect(spy).not.toHaveBeenCalled(); // still served from content, not a stray reservation fetch
	});
});
