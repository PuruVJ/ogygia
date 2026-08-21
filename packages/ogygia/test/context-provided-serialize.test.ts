// The drop-in `setContext` records values into a per-request bag; the handle serializes that bag into
// one page marker. A real layout (x.svelte) sets a FUNCTION (`trackPageView`) — that can't cross an
// island and must be DROPPED (never throw, which would crash the page). A live STORE now BRIDGES via
// the hub's store kind (value crosses, islands reunite to one live instance) — the transportable seam.
import { describe, expect, it } from 'vitest';
import { parse } from 'devalue';
import { serialize_provided_context } from '../dist/context-bridge.js';
import { REF_WIRE_KEY, ref_reviver } from '../dist/ref.js';

const parse_marker = (payload: string) =>
	parse(payload, { [REF_WIRE_KEY]: ref_reviver(true) as (d: never) => unknown }) as Record<
		string,
		unknown
	>;

const map = (entries: [string, unknown][]) => new Map<string, unknown>(entries);

describe('serialize_provided_context drops non-serializable, never crashes', () => {
	it('serializes plain values', () => {
		const payload = serialize_provided_context(
			map([
				['a', 1],
				['b', { x: 'y' }]
			])
		);
		expect(payload).toBeTruthy();
		expect(parse(payload!)).toEqual({ a: 1, b: { x: 'y' } });
	});

	it('drops a function, keeps the rest', () => {
		const payload = serialize_provided_context(
			map([
				['fn', () => {}],
				['keep', 'yes']
			])
		);
		const obj = parse(payload!) as Record<string, unknown>;
		expect(obj.keep).toBe('yes');
		expect('fn' in obj).toBe(false);
	});

	it('BRIDGES a store (the transportable seam), keeps the rest', () => {
		let current: unknown = 'seed';
		const store = {
			subscribe: (fn: (v: unknown) => void) => {
				fn(current);
				return () => {};
			},
			set: (v: unknown) => {
				current = v;
			}
		};
		const payload = serialize_provided_context(
			map([
				['store', store],
				['keep', 42]
			])
		);
		const obj = parse_marker(payload!);
		expect(obj.keep).toBe(42);
		// the store crossed: it revives subscribe-shaped, seeded with its serialize-time value
		const revived = obj.store as { subscribe: (fn: (v: unknown) => void) => () => void };
		expect(typeof revived.subscribe).toBe('function');
		let seen: unknown;
		revived.subscribe((v) => (seen = v))();
		expect(seen).toBe('seed');
	});

	it('returns null when nothing is serializable', () => {
		expect(serialize_provided_context(map([['fn', () => {}]]))).toBeNull();
	});
});
