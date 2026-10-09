// A DEFERRED hole must have the `morph` feature in its bundle. Its answer swaps over a fallback that
// may have become interactive before it landed — a foreign web component upgraded it, or the fallback
// hydrated — and core.ts `#apply` MORPHS that live node rather than replacing it (a plain swap
// re-creates a menu that is open right now; the mega-menu / country-selector discard). Before this,
// `morph` was selected only for live / morph / router, so a defer-only app shipped no `slots.morph`
// and every hole took the `replaceChildren` floor.
import { describe, expect, it } from 'vitest';
import { resolveFeatures, type RuntimeMarks } from '../src/compiler/link/runtime-entry.js';

const marks = (m: Partial<RuntimeMarks>): RuntimeMarks => ({ complete: true, ...m }) as RuntimeMarks;

describe('morph feature — deferred holes', () => {
	it('a deferred hole selects morph (so #apply can keep a live fallback)', () => {
		expect(resolveFeatures(marks({ defer: ['hole-1'] }))).toContain('morph');
	});

	it('morph and frames travel together for a deferred hole (same streamed HTML)', () => {
		const features = resolveFeatures(marks({ defer: ['hole-1'] }));
		expect(features).toContain('morph');
		expect(features).toContain('frames');
	});

	it('a plain load-hydrated app (no defer, no live/morph/router) still ships neither', () => {
		const features = resolveFeatures(marks({ hydrate: ['load'] }));
		expect(features).not.toContain('morph');
		expect(features).not.toContain('frames');
	});

	it('the existing legs are unchanged: live / morph / router each still select morph', () => {
		expect(resolveFeatures(marks({ live: true }))).toContain('morph');
		expect(resolveFeatures(marks({ morph: true }))).toContain('morph');
		expect(resolveFeatures(marks({ router: true }))).toContain('morph');
	});
});
