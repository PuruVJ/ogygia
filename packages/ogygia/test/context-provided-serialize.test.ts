// The drop-in `setContext` records values into a per-request bag; the handle serializes that bag into
// one page marker. A real layout (x.svelte) sets a FUNCTION (`trackPageView`) and a live store — values
// that can't cross an island. `serialize_provided_context` must DROP those and bridge the rest, never
// throw (which would crash the page).
import { describe, expect, it } from 'vitest';
import { parse } from 'devalue';
import { serialize_provided_context } from '../dist/context-bridge.js';

const map = (entries: [string, unknown][]) => new Map<string, unknown>(entries);

describe('serialize_provided_context drops non-serializable, never crashes', () => {
	it('serializes plain values', () => {
		const payload = serialize_provided_context(map([['a', 1], ['b', { x: 'y' }]]));
		expect(payload).toBeTruthy();
		expect(parse(payload!)).toEqual({ a: 1, b: { x: 'y' } });
	});

	it('drops a function, keeps the rest', () => {
		const payload = serialize_provided_context(map([['fn', () => {}], ['keep', 'yes']]));
		const obj = parse(payload!) as Record<string, unknown>;
		expect(obj.keep).toBe('yes');
		expect('fn' in obj).toBe(false);
	});

	it('drops a store (object with function props), keeps the rest', () => {
		const store = { subscribe: () => () => {}, set: () => {} };
		const payload = serialize_provided_context(map([['store', store], ['keep', 42]]));
		const obj = parse(payload!) as Record<string, unknown>;
		expect(obj.keep).toBe(42);
		expect('store' in obj).toBe(false);
	});

	it('returns null when nothing is serializable', () => {
		expect(serialize_provided_context(map([['fn', () => {}]]))).toBeNull();
	});
});
