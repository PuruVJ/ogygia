import { describe, expect, it } from 'vitest';
import {
	is_awake,
	is_deferred,
	is_frozen,
	region_is_vacant,
	region_remount,
	region_schedule
} from '../src/runtime/region-attrs.js';

/** Minimal Element-like for attribute helpers (no DOM env). */
class FakeEl {
	constructor(readonly attrs: Record<string, string> = {}) {}
	getAttribute(name: string) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
	}
}

/** Minimal ParentNode-like for vacancy checks. */
class FakeParent {
	constructor(readonly childNodes: Array<{ nodeType: number; textContent?: string }>) {}
}

describe('region-attrs (two-axis DOM)', () => {
	it('is_awake only for hydrate schedules, not none', () => {
		expect(is_awake(new FakeEl({ hydrate: 'load' }))).toBe(true);
		expect(is_awake(new FakeEl({ hydrate: 'idle' }))).toBe(true);
		expect(is_awake(new FakeEl({ hydrate: '(max-width: 600px)' }))).toBe(true);
		expect(is_awake(new FakeEl({ hydrate: 'none' }))).toBe(false);
		expect(is_awake(new FakeEl({ render: 'defer', when: 'load' }))).toBe(false);
	});

	it('is_frozen matches hydrate="none"', () => {
		expect(is_frozen(new FakeEl({ hydrate: 'none' }))).toBe(true);
		expect(is_frozen(new FakeEl({ hydrate: 'load' }))).toBe(false);
		expect(is_frozen(new FakeEl({}))).toBe(false);
	});

	it('region_remount defaults to cache', () => {
		expect(region_remount(new FakeEl({ hydrate: 'none' }))).toBe('cache');
		expect(region_remount(new FakeEl({ remount: 'cache' }))).toBe('cache');
		expect(region_remount(new FakeEl({ remount: 'empty' }))).toBe('empty');
		expect(region_remount(new FakeEl({ remount: 'swr' }))).toBe('swr');
	});

	it('region_is_vacant treats comments/whitespace as empty but text/elements as filled', () => {
		expect(region_is_vacant(new FakeParent([]) as unknown as ParentNode)).toBe(true);
		expect(
			region_is_vacant(
				new FakeParent([{ nodeType: 8 }, { nodeType: 3, textContent: '  \n' }]) as unknown as ParentNode
			)
		).toBe(true);
		expect(
			region_is_vacant(
				new FakeParent([{ nodeType: 3, textContent: 'frozen text' }]) as unknown as ParentNode
			)
		).toBe(false);
		expect(region_is_vacant(new FakeParent([{ nodeType: 1 }]) as unknown as ParentNode)).toBe(false);
	});

	it('is_deferred / region_schedule use render+when', () => {
		const hole = new FakeEl({ render: 'defer', when: 'visible' });
		expect(is_deferred(hole)).toBe(true);
		expect(region_schedule(hole)).toBe('visible');
		expect(region_schedule(new FakeEl({ render: 'defer' }))).toBe('load');
		expect(region_schedule(new FakeEl({ hydrate: 'idle' }))).toBe('idle');
		// frozen regions don't schedule a wake; default load is unused for them
		expect(region_schedule(new FakeEl({ hydrate: 'none' }))).toBe('load');
	});
});
