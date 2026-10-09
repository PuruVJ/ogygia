/**
 * Hub v2 phase W — the `watch` / `notify` subscription primitive on the hub.
 *
 * The one mechanism every "a value arrives later for this identity" channel (region frames,
 * streamed page-data, live refresh) migrates onto. Verifies: subscribe/unsubscribe bookkeeping,
 * direct notify, resolve's live-merge-on-re-resolve path, and that an UNWATCHED id keeps the
 * old reunification-by-identity behavior byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import {
	register_kind,
	resolve,
	watch,
	notify,
	dispose_scope,
	dispose_ids,
	register_scope_disposer,
	batch,
	resolve_batch
} from '../src/ref.js';

// a tiny "counter" kind with a merge: decode makes {v}; merge folds fresh v into the live object
let registered = false;
function ensure_counter_kind() {
	if (registered) return;
	registered = true;
	register_kind({
		k: 'test-counter',
		match: (v) => typeof v === 'object' && v !== null && '__counter' in (v as object),
		encode: (v) => ({ d: { v: (v as { v: number }).v } }),
		decode: (ref) => ({ __counter: true, v: (ref.d as { v: number }).v }),
		merge: (live, ref) => {
			(live as { v: number }).v = (ref.d as { v: number }).v;
		}
	});
}

describe('watch / notify primitive', () => {
	it('subscribe returns an unsubscribe that removes exactly its callback', () => {
		const hits: number[] = [];
		const a = watch('id-1', () => hits.push(1));
		const b = watch('id-1', () => hits.push(2));
		notify('id-1', null);
		expect(hits.sort()).toEqual([1, 2]);
		a();
		notify('id-1', null);
		expect(hits.sort()).toEqual([1, 2, 2]); // only b remained
		b();
		notify('id-1', null); // no watchers → no throw, no hit
		expect(hits.sort()).toEqual([1, 2, 2]);
	});

	it('notify passes the settled value through; a throwing watcher does not starve others', () => {
		const seen: unknown[] = [];
		watch('id-2', () => {
			throw new Error('boom');
		});
		const off = watch('id-2', (v) => seen.push(v));
		notify('id-2', { frame: 'html' });
		expect(seen).toEqual([{ frame: 'html' }]);
		off();
	});

	it('re-resolving a WATCHED id merges fresh data in place and notifies', () => {
		ensure_counter_kind();
		const first = resolve({ k: 'test-counter', i: 'c1', d: { v: 10 } }, true) as { v: number };
		expect(first.v).toBe(10);

		const seen: number[] = [];
		const off = watch('c1', (live) => seen.push((live as { v: number }).v));

		// fresh data for the SAME id — same live instance, value folded in, watcher fired
		const again = resolve({ k: 'test-counter', i: 'c1', d: { v: 42 } }, true) as { v: number };
		expect(again).toBe(first); // identity preserved
		expect(again.v).toBe(42); // merged in place
		expect(seen).toEqual([42]); // watcher notified
		off();
	});

	it('re-resolving an UNWATCHED id is the old early-return: no merge, no notify', () => {
		ensure_counter_kind();
		const first = resolve({ k: 'test-counter', i: 'c2', d: { v: 1 } }, true) as { v: number };
		// no watcher registered → fresh data is IGNORED, identity returned untouched
		const again = resolve({ k: 'test-counter', i: 'c2', d: { v: 999 } }, true) as { v: number };
		expect(again).toBe(first);
		expect(again.v).toBe(1); // NOT merged — reunification-by-identity intact
	});

	it('server path (remember:false) never reaches the watch machinery', () => {
		ensure_counter_kind();
		const seen: number[] = [];
		watch('c3', (live) => seen.push((live as { v: number }).v));
		// remember:false always decodes fresh, never consults live/watchers
		const a = resolve({ k: 'test-counter', i: 'c3', d: { v: 5 } }, false) as { v: number };
		const b = resolve({ k: 'test-counter', i: 'c3', d: { v: 7 } }, false) as { v: number };
		expect(a).not.toBe(b);
		expect(seen).toEqual([]); // no notifications on the request-scoped path
	});
});

describe('scope (hub v2 phase S)', () => {
	it('the string scope API matches the boolean shim: page↔true, request↔false', () => {
		ensure_counter_kind();
		// page (true) memoizes by id; a second resolve returns the SAME instance
		const a1 = resolve({ k: 'test-counter', i: 's1', d: { v: 1 } }, 'page') as object;
		const a2 = resolve({ k: 'test-counter', i: 's1', d: { v: 1 } }, true) as object;
		expect(a2).toBe(a1); // 'page' and true share the page bucket

		// request (false) never memoizes — always fresh
		const b1 = resolve({ k: 'test-counter', i: 's2', d: { v: 1 } }, 'request') as object;
		const b2 = resolve({ k: 'test-counter', i: 's2', d: { v: 1 } }, false) as object;
		expect(b2).not.toBe(b1);
	});

	it('request scope leaves no page-bucket residue (server isolation)', () => {
		ensure_counter_kind();
		resolve({ k: 'test-counter', i: 's3', d: { v: 1 } }, 'request');
		// a later page resolve of the same id must NOT find a request-scoped instance
		const seen: number[] = [];
		const off = watch('s3', (l) => seen.push((l as { v: number }).v));
		const page = resolve({ k: 'test-counter', i: 's3', d: { v: 9 } }, 'page') as { v: number };
		expect(page.v).toBe(9); // fresh decode, not a leaked request instance
		off();
	});
});

describe('dispose_scope + Kind.dispose + scope disposers (hub v2 phase D)', () => {
	let disposed: number[] = [];
	let disposableRegistered = false;
	function ensure_disposable_kind() {
		if (disposableRegistered) return;
		disposableRegistered = true;
		register_kind({
			k: 'test-disposable',
			match: (v) => typeof v === 'object' && v !== null && '__disp' in (v as object),
			encode: (v) => ({ d: { n: (v as { n: number }).n } }),
			decode: (ref) => ({ __disp: true, n: (ref.d as { n: number }).n }),
			dispose: (live) => disposed.push((live as { n: number }).n)
		});
	}

	it('dispose_scope tears down each page instance via kind.dispose and empties the bucket', () => {
		ensure_disposable_kind();
		disposed = [];
		resolve({ k: 'test-disposable', i: 'd1', d: { n: 1 } }, 'page');
		resolve({ k: 'test-disposable', i: 'd2', d: { n: 2 } }, 'page');
		dispose_scope('page');
		expect(disposed.sort()).toEqual([1, 2]);
		// bucket emptied: a re-resolve of the same id decodes FRESH (not the disposed instance)
		disposed = [];
		const again = resolve({ k: 'test-disposable', i: 'd1', d: { n: 9 } }, 'page') as { n: number };
		expect(again.n).toBe(9);
	});

	it('a session-aliased instance is NOT disposed by dispose_scope(page)', () => {
		// a kind whose keep_name promotes to session, and that also aliases into page
		let sessDisposed = 0;
		register_kind({
			k: 'test-sess',
			match: (v) => typeof v === 'object' && v !== null && '__sess' in (v as object),
			encode: (v) => ({ d: {} }),
			decode: () => ({ __sess: true }),
			keep_name: () => 'the-session-thing',
			dispose: () => void sessDisposed++
		});
		resolve({ k: 'test-sess', i: 'sess-page-alias', d: {} }, 'page'); // lands in BOTH page + session
		dispose_scope('page');
		expect(sessDisposed).toBe(0); // survived — it belongs to the session
	});

	it('registered scope disposers run on dispose (the fold hook)', () => {
		let ran = 0;
		const off = register_scope_disposer('page', () => void ran++);
		dispose_scope('page');
		expect(ran).toBe(1);
		off();
		dispose_scope('page');
		expect(ran).toBe(1); // unregistered
	});
});

describe('batch / resolve_batch (hub v2 phase B)', () => {
	it('buffers watch notifications until the batch exits — no torn cross-ref state', () => {
		ensure_counter_kind();
		// two watched ids; both re-resolved (merged) inside one batch
		resolve({ k: 'test-counter', i: 'b1', d: { v: 1 } }, 'page');
		resolve({ k: 'test-counter', i: 'b2', d: { v: 1 } }, 'page');
		const order: string[] = [];
		const o1 = watch('b1', (l) => order.push('b1=' + (l as { v: number }).v));
		const o2 = watch('b2', (l) => order.push('b2=' + (l as { v: number }).v));

		resolve_batch(
			[
				{ k: 'test-counter', i: 'b1', d: { v: 10 } },
				{ k: 'test-counter', i: 'b2', d: { v: 20 } }
			],
			'page'
		);
		// both merges happened before EITHER watcher fired (values already final when notified)
		expect(order.sort()).toEqual(['b1=10', 'b2=20']);
		o1();
		o2();
	});

	it('collapses repeat notifies for one id to a single final-value fire', () => {
		ensure_counter_kind();
		resolve({ k: 'test-counter', i: 'b3', d: { v: 1 } }, 'page');
		const seen: number[] = [];
		const off = watch('b3', (l) => seen.push((l as { v: number }).v));
		batch(() => {
			resolve({ k: 'test-counter', i: 'b3', d: { v: 5 } }, 'page');
			resolve({ k: 'test-counter', i: 'b3', d: { v: 9 } }, 'page');
		});
		expect(seen).toEqual([9]); // one fire, final value — not [5, 9]
		off();
	});

	it('batch returns fn result and is reentrant', () => {
		const r = batch(() => batch(() => 42));
		expect(r).toBe(42);
	});
});

describe('dispose_ids — selective disposal (reconciler R3)', () => {
	let gone: number[] = [];
	let reg = false;
	function ensure_disp2() {
		if (reg) return;
		reg = true;
		register_kind({
			k: 'test-disp2',
			match: (v) => typeof v === 'object' && v !== null && '__d2' in (v as object),
			encode: (v) => ({ d: { n: (v as { n: number }).n } }),
			decode: (r) => ({ __d2: true, n: (r.d as { n: number }).n }),
			dispose: (l) => gone.push((l as { n: number }).n)
		});
	}

	it('disposes only the named page ids, leaving the rest', () => {
		ensure_disp2();
		gone = [];
		resolve({ k: 'test-disp2', i: 'x1', d: { n: 1 } }, 'page');
		resolve({ k: 'test-disp2', i: 'x2', d: { n: 2 } }, 'page');
		resolve({ k: 'test-disp2', i: 'x3', d: { n: 3 } }, 'page');
		dispose_ids(['x1', 'x3']);
		expect(gone.sort()).toEqual([1, 3]);
		// x2 still resolvable to the SAME instance (not disposed)
		const again = resolve({ k: 'test-disp2', i: 'x2', d: { n: 99 } }, 'page') as { n: number };
		expect(again.n).toBe(2);
		// x1 was removed → re-resolve decodes fresh
		const fresh = resolve({ k: 'test-disp2', i: 'x1', d: { n: 7 } }, 'page') as { n: number };
		expect(fresh.n).toBe(7);
	});

	it('unknown ids are skipped; a session-aliased id is not torn down', () => {
		ensure_disp2();
		gone = [];
		dispose_ids(['nope']); // no throw, no dispose
		expect(gone).toEqual([]);
		// a keep_name kind lands in BOTH page + session; dispose_ids on the page id must NOT dispose it
		let sessGone = 0;
		register_kind({
			k: 'test-disp-sess',
			match: (v) => typeof v === 'object' && v !== null && '__ds' in (v as object),
			encode: () => ({ d: {} }),
			decode: () => ({ __ds: true }),
			keep_name: () => 'ds-name',
			dispose: () => void sessGone++
		});
		resolve({ k: 'test-disp-sess', i: 'ds-page', d: {} }, 'page'); // page + session aliased
		dispose_ids(['ds-page']);
		expect(sessGone).toBe(0);
	});
});
