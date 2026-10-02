// What an island left running after it left the page (devtools/leftovers.ts): the stack read with no
// regex, the owner by location or (dev) by name, and left behind only when no copy alive now made it.
import { describe, expect, it } from 'vitest';
import { owned_leftovers, stack_files, type LeftoverIsland, type LeftoverReg } from '../src/devtools/leftovers.js';

describe('leftovers', () => {
	it('reads each frame’s file: Chrome, Firefox/Safari, no position, no query', () => {
		const chrome = 'Error\n    at callers (http://a.test/@fs/og/leftovers.ts:80:9)\n    at $effect (http://a.test/src/lib/Ticker.svelte?t=1:7:3)\n    at http://a.test/assets/x.js:1:200\n    at <anonymous>';
		expect(stack_files(chrome)).toEqual(['http://a.test/@fs/og/leftovers.ts', 'http://a.test/src/lib/Ticker.svelte', 'http://a.test/assets/x.js']);
		expect(stack_files('callers@http://a.test/l.js:3:1\nfx@http://a.test/src/lib/T.svelte:4:2')).toEqual(['http://a.test/l.js', 'http://a.test/src/lib/T.svelte']);
	});

	const ticker: LeftoverIsland = { entry: '/@id/virtual:ogygia/island/aa.js', urls: ['http://a.test/@id/virtual:ogygia/island/aa.js'], live: [], first: 10, gone: 500 };
	const name_of = (e: string) => (e.includes('aa') ? 'Ticker' : 'Other');
	const interval = (t: number, frames = ['http://a.test/src/lib/Ticker.svelte']): LeftoverReg => ({ kind: 'interval', frames, t, fires: 40, last: 990 });

	it('an island gone, its interval and listener still set: named, by its .svelte file in dev', () => {
		const regs: LeftoverReg[] = [interval(20), { kind: 'listener', target: 'window', type: 'resize', frames: ['http://a.test/src/lib/Ticker.svelte'], t: 21, fires: 0 }];
		expect(owned_leftovers(regs, [ticker], name_of, 1000)).toEqual([{ name: 'Ticker', entry: ticker.entry, intervals: 1, listeners: ["window 'resize'"], fires: 40, last_ago: 10 }]);
	});

	it('by location in a build: the caller’s caller is the island’s file', () => {
		const built = { ...ticker, urls: ['http://a.test/_app/immutable/og-region.aa-123.js'] };
		const regs = [interval(20, ['http://a.test/_app/immutable/use-tick.js', 'http://a.test/_app/immutable/og-region.aa-123.js'])];
		expect(owned_leftovers(regs, [built], name_of, 1000).map((l) => l.name)).toEqual(['Ticker']);
	});

	it('a copy alive now that was there to make it: not left behind (one kept across the navigation)', () => {
		expect(owned_leftovers([interval(20)], [{ ...ticker, live: [10] }], name_of, 1000)).toEqual([]);
	});

	it('back on its page, a new copy alive: the old copy’s interval is still named', () => {
		expect(owned_leftovers([interval(20)], [{ ...ticker, live: [600] }], name_of, 1000)).toHaveLength(1);
		// (the new copy's own interval is not)
		expect(owned_leftovers([interval(610)], [{ ...ticker, live: [600] }], name_of, 1000)).toEqual([]);
	});

	it('made before any copy started (module code, Svelte’s own delegation), or by no island: quiet', () => {
		expect(owned_leftovers([interval(5)], [ticker], name_of, 1000)).toEqual([]);
		expect(owned_leftovers([interval(20, ['http://a.test/src/lib/Unrelated.svelte'])], [ticker], name_of, 1000)).toEqual([]);
	});
});
