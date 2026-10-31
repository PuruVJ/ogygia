// The interaction capture ships for every island that hydrates on the client: a scheduled one
// (`load` / `idle` / `visible` / media) is armed until it is live, so a click before then is replayed.
import { describe, it, expect } from 'vitest';
import { resolveFeatures } from '../src/compiler/link/runtime-entry.ts';

const has = (hydrate: string[]) =>
	resolveFeatures({ complete: true, hydrate }).includes('interaction');

describe('the interaction feature', () => {
	it('ships for any island that hydrates', () => {
		for (const w of ['interaction', 'load', 'idle', 'visible', '(max-width: 600px)'])
			expect(has([w]), w).toBe(true);
	});
	it('not for a page of lakes only, nor a page with no islands', () => {
		expect(has(['none'])).toBe(false);
		expect(has([])).toBe(false);
	});
});
