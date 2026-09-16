/**
 * The island entry's hydrate contract carries `options.recover`: the consumer's self-heal
 * (runtime/hydrate-core.ts) asks the entry's OWN svelte to throw on a mismatch instead of silently
 * re-rendering, and the envelope is re-checked per call because a restore from the server markup
 * drops it. Same-origin wakes never call this (hydrate-core hydrates directly); fragment federation
 * does, across builds — so the shape is part of the contract, pinned here.
 */
import { describe, expect, it } from 'vitest';
import { island_entry_source } from '../dist/compiler/region/emit.js';

describe('island_entry_source — the foreign-hydrate contract', () => {
	const src = island_entry_source('/src/lib/Tiny.svelte', 'abc123');

	it('__og_hydrate takes options and forwards recover:false to svelte, nothing otherwise', () => {
		expect(src).toContain('export function __og_hydrate(target, props, options)');
		expect(src).toContain("options && options.recover === false ? { recover: false } : {}");
		expect(src).toMatch(/__og_h\(__og_NP, \{ target, props: \{ component: __OgygiaComp_abc123, props \}, \.\.\.recovery \}\)/);
	});

	it('the envelope is re-checked on every call (a restore drops it), not remembered on the target', () => {
		expect(src).not.toContain('__og_env');
		expect(src).toContain("first.nodeType === 8 && first.data === '['");
	});

	it('still exports the unmounter and the component default', () => {
		expect(src).toContain('export function __og_unmount(app)');
		expect(src).toContain('export default __OgygiaComp_abc123;');
	});
});
