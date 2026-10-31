/**
 * The island entry's hydrate contract carries `options.recover`: the consumer's self-heal
 * (runtime/hydrate-core.ts) asks the entry's OWN svelte to throw on a mismatch instead of silently
 * re-rendering, and the envelope is re-checked per call because a restore from the server markup
 * drops it. Same-origin wakes never call this (hydrate-core hydrates directly); fragment federation
 * does, across builds — so the shape is part of the contract, pinned here. The entry delegates to
 * ONE helper in the producer's build (src/entry-hydrate.ts), after a mark the compiler cuts from for
 * an app that does not federate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { island_entry_source, FOREIGN_HYDRATE_MARK } from '../dist/compiler/region/emit.js';

describe('island_entry_source — the foreign-hydrate contract', () => {
	const src = island_entry_source('/src/lib/Tiny.svelte', 'abc123');
	const helper = readFileSync(new URL('../src/entry-hydrate.ts', import.meta.url), 'utf8');

	it('__og_hydrate takes options and hands them to the producer’s helper with this component', () => {
		expect(src).toContain('export function __og_hydrate(target, props, options)');
		expect(src).toContain('__og_hy(__OgygiaComp_abc123, target, props, options)');
		expect(src).toContain("from 'ogygia/internal'");
	});

	it('the helper forwards recover:false to svelte, nothing otherwise, and re-checks the envelope every call', () => {
		expect(helper).toContain("options && options.recover === false ? { recover: false } : {}");
		expect(helper).toContain("first.nodeType === 8 && (first as Comment).data === '['");
		expect(helper).not.toContain('__og_env');
	});

	it('still exports the unmounter and the component default; the foreign exports sit after the mark', () => {
		expect(src).toContain('export { __og_unmount }');
		expect(src).toContain('export default __OgygiaComp_abc123;');
		const mark = src.indexOf(FOREIGN_HYDRATE_MARK);
		expect(mark).toBeGreaterThan(src.indexOf('export default'));
		// (cut at the mark: a plain entry — the component and the transportables map, nothing else)
		expect(src.slice(0, mark)).not.toContain('__og_hydrate');
	});
});
