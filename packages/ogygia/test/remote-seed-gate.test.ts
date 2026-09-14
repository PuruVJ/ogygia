/**
 * REMOTE SEED ONLY WHEN REACHABLE — the handle's per-remote decision when it builds the
 * `application/ogygia-remote` seed (server/remote-seed-gate.ts): seed an SSR-resolved remote only
 * when some region rendered on the page has client code that can call it. `wanted` is the union of
 * every region's `islandRemotes(entry)` (Kit id-hashes); `null` = a region answered fail-open.
 *
 * Two layers: `remote_seed_wanted` (the one decision) and `collect_remote_seed` (the whole
 * bucketing the handle serializes — Kit's q/p/l/f parity, private / pending / errored / baked
 * skips), driven across every permutation of remote type × caller reachability, and at scale.
 */
import { describe, expect, it } from 'vitest';
import {
	remote_seed_wanted,
	collect_remote_seed,
	type ImplicitRemote
} from '../src/server/remote-seed-gate.js';

const key = (id: string, payload: string) => `${id}/${payload}`;
const BAKED = Symbol.for('ogygia.baked-marker');
// mirrors the handle's `has_baked_region`: a baked marker anywhere in the value (depth-capped)
const skip_value = (v: unknown, depth = 0): boolean => {
	if (depth > 6 || typeof v !== 'object' || v === null) return false;
	if (BAKED in v) return true;
	return Object.values(v).some((x) => skip_value(x, depth + 1));
};

/** A fake `state.remote.implicit` entry: one remote, N payloads → results (a thenable or a value). */
const remote = (id: string | undefined, type: string, results: Record<string, unknown>) =>
	[
		{ id, type } as ImplicitRemote,
		Object.fromEntries(Object.entries(results).map(([p, r]) => [p, () => r]))
	] as [ImplicitRemote, Record<string, () => unknown>];

describe('remote_seed_wanted', () => {
	it('null (unknown) → every remote seeds, the pre-gate rule', () => {
		expect(remote_seed_wanted('1rczqrp/footerProps', null)).toBe(true);
		expect(remote_seed_wanted('bjveep/getGreeting', null)).toBe(true);
	});

	it('a remote whose module some island can call → seeds', () => {
		const wanted = new Set(['bjveep']);
		expect(remote_seed_wanted('bjveep/getGreeting', wanted)).toBe(true);
		expect(remote_seed_wanted('bjveep/getCount', wanted)).toBe(true); // any export of that module
	});

	it('a remote no island on the page imports → NOT seeded (a lake / page-script call: server render only)', () => {
		const wanted = new Set(['bjveep']);
		expect(remote_seed_wanted('1rczqrp/footerProps', wanted)).toBe(false);
	});

	it('an empty set (islands on the page, none calls a remote) → nothing seeds', () => {
		expect(remote_seed_wanted('1rczqrp/footerProps', new Set())).toBe(false);
	});

	it('matches on the id-hash PREFIX only — a hash that merely starts the same is a different module', () => {
		const wanted = new Set(['1rczqrp']);
		expect(remote_seed_wanted('1rczqrpx/footerProps', wanted)).toBe(false);
		expect(remote_seed_wanted('1rczqr/footerProps', wanted)).toBe(false);
	});

	it('an id without the `${hash}/` shape is kept — fail-open on what it cannot name', () => {
		expect(remote_seed_wanted('form-action-id', new Set())).toBe(true);
	});
});

describe('collect_remote_seed — Kit bucketing × reachability', () => {
	const implicit = () => [
		remote('bjveep/getGreeting', 'query', { '["lake"]': { greeting: 'lake' }, '["reader"]': { greeting: 'reader' } }),
		remote('bjveep/getManifesto', 'prerender', { '[]': { text: 'islands' } }),
		remote('bjveep/clock', 'query_live', { '[]': '12:00' }),
		remote('1rczqrp/footerProps', 'query', { '["fr-FR"]': { logo: 'x' } }),
		remote('form-1', 'form', { 'form-1': { ok: true } }),
		remote(undefined, 'query', { '[]': { secret: 1 } })
	];

	it('wanted = null → everything public seeds, in Kit’s buckets (the pre-gate rule)', async () => {
		const d = await collect_remote_seed(implicit(), null, { key, skip_value });
		expect(Object.keys(d.q).sort()).toEqual(['1rczqrp/footerProps/["fr-FR"]', 'bjveep/getGreeting/["lake"]', 'bjveep/getGreeting/["reader"]']);
		expect(Object.keys(d.p)).toEqual(['bjveep/getManifesto/[]']);
		expect(Object.keys(d.l)).toEqual(['bjveep/clock/[]']);
		expect(Object.keys(d.f)).toEqual(['form-1']); // form outputs keyed by the action id directly
		expect(d.q['bjveep/getGreeting/["lake"]']).toEqual({ v: { greeting: 'lake' } });
	});

	it('a private remote (no id) never seeds, whatever `wanted` says', async () => {
		for (const wanted of [null, new Set<string>(), new Set(['bjveep'])]) {
			const d = await collect_remote_seed(implicit(), wanted, { key, skip_value });
			const all = Object.values(d).flatMap((b) => Object.values(b)) as { v: unknown }[];
			expect(all.some((e) => JSON.stringify(e.v).includes('secret'))).toBe(false);
		}
	});

	it('wanted = {bjveep} → only that module’s remotes seed — every type of it, every payload; the footer does not', async () => {
		const d = await collect_remote_seed(implicit(), new Set(['bjveep']), { key, skip_value });
		expect(Object.keys(d.q).sort()).toEqual(['bjveep/getGreeting/["lake"]', 'bjveep/getGreeting/["reader"]']);
		expect(Object.keys(d.p)).toEqual(['bjveep/getManifesto/[]']);
		expect(Object.keys(d.l)).toEqual(['bjveep/clock/[]']);
		expect(d.q['1rczqrp/footerProps/["fr-FR"]']).toBeUndefined();
	});

	it('wanted = {1rczqrp} → the footer seeds, the greetings module does not', async () => {
		const d = await collect_remote_seed(implicit(), new Set(['1rczqrp']), { key, skip_value });
		expect(Object.keys(d.q)).toEqual(['1rczqrp/footerProps/["fr-FR"]']);
		expect(Object.keys(d.p)).toEqual([]);
		expect(Object.keys(d.l)).toEqual([]);
	});

	it('wanted = {} (islands on the page, none imports a remote) → only the form output survives (fail-open id shape)', async () => {
		const d = await collect_remote_seed(implicit(), new Set(), { key, skip_value });
		expect(Object.keys(d.q)).toEqual([]);
		expect(Object.keys(d.p)).toEqual([]);
		expect(Object.keys(d.l)).toEqual([]);
		expect(Object.keys(d.f)).toEqual(['form-1']);
	});

	it('the memo of already-awaited results wins over re-invoking the record', async () => {
		let invoked = 0;
		const entry = remote('bjveep/getGreeting', 'query', { '[]': { fresh: true } });
		entry[1]['[]'] = () => {
			invoked++;
			return { fresh: true };
		};
		const d = await collect_remote_seed([entry], null, {
			key,
			memo: () => ({ '[]': { memo: true } })
		});
		expect(d.q['bjveep/getGreeting/[]']).toEqual({ v: { memo: true } });
		expect(invoked).toBe(0);
	});

	it('a still-PENDING result is omitted (the client fetches it) — a resolved sibling payload still seeds', async () => {
		const pending = new Promise(() => {});
		const d = await collect_remote_seed(
			[remote('bjveep/getGreeting', 'query', { '["slow"]': pending, '["fast"]': Promise.resolve({ ok: 1 }) })],
			null,
			{ key }
		);
		expect(Object.keys(d.q)).toEqual(['bjveep/getGreeting/["fast"]']);
	});

	it('an ERRORED result is omitted, never throws the seed build', async () => {
		const d = await collect_remote_seed(
			[remote('bjveep/getGreeting', 'query', { '[]': Promise.reject(new Error('boom')) })],
			null,
			{ key }
		);
		expect(d.q).toEqual({});
	});

	it('a value carrying a BAKED region is skipped (a page-sized render, not data), the rest seeds', async () => {
		const d = await collect_remote_seed(
			[remote('docs/page', 'query', { '["a"]': { body: { [BAKED]: true } }, '["b"]': { title: 'b' } })],
			null,
			{ key, skip_value }
		);
		expect(Object.keys(d.q)).toEqual(['docs/page/["b"]']);
	});

	it('an unknown type is dropped (Kit parity: only q/p/l/f buckets exist)', async () => {
		const d = await collect_remote_seed([remote('x/y', 'command', { '[]': 1 })], null, { key });
		expect(Object.values(d).every((b) => Object.keys(b).length === 0)).toBe(true);
	});

	it('the permutation grid: {query, prerender, live} × {lake-only, island-reachable, fail-open}', async () => {
		const types = ['query', 'prerender', 'query_live'] as const;
		const bucket_of = { query: 'q', prerender: 'p', query_live: 'l' } as const;
		for (const type of types) {
			const entries = [remote(`aaa/one`, type, { '[]': 1 }), remote(`bbb/two`, type, { '[]': 2 })];
			// lake-only (nothing reachable) → nothing
			expect(Object.keys((await collect_remote_seed(entries, new Set(), { key }))[bucket_of[type]])).toEqual([]);
			// island reaches module aaa only
			expect(Object.keys((await collect_remote_seed(entries, new Set(['aaa']), { key }))[bucket_of[type]])).toEqual(['aaa/one/[]']);
			// fail-open
			expect(Object.keys((await collect_remote_seed(entries, null, { key }))[bucket_of[type]]).sort()).toEqual(['aaa/one/[]', 'bbb/two/[]']);
		}
	});

	it('at scale: 2 000 remotes × 3 payloads, 400 reachable modules — exact set, well under a second', async () => {
		const entries: [ImplicitRemote, Record<string, () => unknown>][] = [];
		const wanted = new Set<string>();
		const expected = new Set<string>();
		for (let i = 0; i < 2000; i++) {
			const hash = `h${i.toString(36)}`;
			const reachable = i % 5 === 0;
			if (reachable) wanted.add(hash);
			const payloads: Record<string, unknown> = {};
			for (let p = 0; p < 3; p++) {
				payloads[`[${p}]`] = { i, p };
				if (reachable) expected.add(`${hash}/fn/[${p}]`);
			}
			entries.push(remote(`${hash}/fn`, 'query', payloads));
		}
		const t0 = performance.now();
		const d = await collect_remote_seed(entries, wanted, { key, skip_value });
		const ms = performance.now() - t0;
		expect(new Set(Object.keys(d.q))).toEqual(expected);
		expect(Object.keys(d.q).length).toBe(400 * 3);
		expect(ms).toBeLessThan(1000);
	});
});
