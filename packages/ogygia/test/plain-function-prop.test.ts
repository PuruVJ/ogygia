// REGRESSION: a plain function passed as an island prop is indistinguishable from a Svelte snippet
// (both are functions), so ogygia freezes it via SSR — and when that fails it USED to blame "a snippet
// can't cross an island boundary", which is wrong when the author passed a callback, not a snippet.
// The error must lead with "function", name the prop, and put the plain-function case first.
import { describe, expect, it } from 'vitest';
import { prepare_region_props } from '../src/region-snippet.js';

describe('a plain function passed as an island prop', () => {
	it('errors as a FUNCTION (not a snippet), naming the prop and the callback case', () => {
		// A callback, not a snippet — rendering it as a snippet throws, which is the crossing failure.
		const onSelect = () => {
			throw new Error('I am a callback, not a snippet');
		};
		let err: Error | null = null;
		try {
			prepare_region_props({ onSelect });
		} catch (e) {
			err = e as Error;
		}
		expect(err, 'expected prepare_region_props to throw for a plain function prop').toBeTruthy();
		const msg = err!.message;
		expect(msg, msg).toMatch(/prop `onSelect`/);
		expect(msg, msg).toMatch(/is a function that can't cross the island boundary/);
		// leads with the plain-function cause, not a bare "snippet" framing
		expect(msg, msg).toMatch(/PLAIN function/);
		expect(msg, msg).not.toMatch(/^\[ogygia\] a snippet can't cross/);
	});

	it('a real region snippet (branded) passes through untouched', () => {
		const snip = Object.assign(() => {}, { __ogRegion: { m: 'static' as const, h: '<i>x</i>' } });
		const out = prepare_region_props({ children: snip });
		// branded → not re-frozen, same reference kept
		expect(out.children).toBe(snip);
	});
});
