/**
 * Slot marker ids are PER REQUEST: the same page rendered twice mints the same ids (byte-identical
 * HTML across requests), a hole endpoint render prefixes its ids with its region id so a spliced
 * hole never collides with the page's own markers, and off-request the process counter stands in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { next_slot_id } from '../src/region-snippet.js';
import { set_kit_event_reader } from '../src/server/kit-context.js';

// the handle installs this reader in an app; here each test installs its own request
const set_request_event_stub = (fn: (() => unknown) | null) => set_kit_event_reader(fn);
afterEach(() => set_request_event_stub(null));

const page_event = () => ({ url: new URL('http://s/us/en/brands/') });
const hole_event = () => ({ url: new URL('http://s/__ogygia__?id=a77ff8566c02&props=e30&exp=1&sig=s') });

describe('next_slot_id', () => {
	it('two requests of the same page mint the same sequence', () => {
		const a = page_event();
		set_request_event_stub(() => a);
		const first = [next_slot_id(), next_slot_id(), next_slot_id()];
		const b = page_event();
		set_request_event_stub(() => b);
		const second = [next_slot_id(), next_slot_id(), next_slot_id()];
		expect(second).toEqual(first);
		expect(first).toEqual(['og1', 'og2', 'og3']);
	});

	it('a hole endpoint render prefixes its ids with its region id (no collision when spliced)', () => {
		const h = hole_event();
		set_request_event_stub(() => h);
		expect(next_slot_id()).toBe('oga77ff8-1');
		expect(next_slot_id()).toBe('oga77ff8-2');
	});

	it('off-request: unique, monotonic ids from the process counter', () => {
		const a = next_slot_id();
		const b = next_slot_id();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^og[0-9a-z]+$/);
	});
});
