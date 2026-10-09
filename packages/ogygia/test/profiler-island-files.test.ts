/**
 * WHAT A DEPLOY COSTS A RETURNING VISITOR (compare.ts `island_files_diff`): between two profiles of a
 * page, each island kept its content-hashed file (still cached) or moved to a new one (downloaded
 * again). Islands keyed by identity, files by location.
 */
import { describe, it, expect } from 'vitest';
import { island_files_diff } from '../src/profiler/compare.js';

const id = (n: string) => `/_app/immutable/og-region.${n}.js`;
const row = (n: string, hash: string, name = n) => ({ entry: id(n), name, module_url: `/_app/immutable/og-region.${n}.${hash}.js` });

describe('island_files_diff', () => {
	it('moved and kept, the moved files weighed from the second build', () => {
		const a = [row('aaaaaaaaaaaa', 'Old11111', 'Probe'), row('bbbbbbbbbbbb', 'Same2222', 'Steady')];
		const b = [row('aaaaaaaaaaaa', 'New33333', 'Probe'), row('bbbbbbbbbbbb', 'Same2222', 'Steady')];
		const d = island_files_diff(a, b, (u) => (u.includes('New33333') ? 4096 : undefined))!;
		expect(d.moved).toEqual([{ name: 'Probe', bytes: 4096 }]);
		expect(d.kept).toBe(1);
		expect(d.bytes).toBe(4096);
		expect(d.all_moved).toBe(false);
	});

	it('every island moved (three or more): the build’s names are not stable', () => {
		const names = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'];
		const d = island_files_diff(names.map((n) => row(n, 'Old11111')), names.map((n) => row(n, 'New22222')))!;
		expect(d.all_moved).toBe(true);
		expect(d.bytes).toBe(0);
		// two moved of two is not enough to say it
		expect(island_files_diff(names.slice(0, 2).map((n) => row(n, 'Old11111')), names.slice(0, 2).map((n) => row(n, 'New22222')))!.all_moved).toBe(false);
	});

	it('a build from before content hashing (the file is the identity) never counts as moved', () => {
		const pre = [{ entry: id('aaaaaaaaaaaa'), name: 'Probe', module_url: id('aaaaaaaaaaaa') }];
		expect(island_files_diff(pre, [row('aaaaaaaaaaaa', 'New11111')])).toBeNull();
		expect(island_files_diff([row('aaaaaaaaaaaa', 'Old11111')], pre)).toBeNull();
	});

	it('an island new in the second build, or copies of one island, count once or not at all', () => {
		const d = island_files_diff([row('aaaaaaaaaaaa', 'Old11111')], [row('aaaaaaaaaaaa', 'New11111'), row('aaaaaaaaaaaa', 'New11111'), row('dddddddddddd', 'Fresh111')])!;
		expect(d.moved).toHaveLength(1);
		expect(d.kept).toBe(0);
	});

	it('no islands in common: nothing to say', () => {
		expect(island_files_diff([], [row('aaaaaaaaaaaa', 'X1234567')])).toBeNull();
		expect(island_files_diff([], [])).toBeNull();
	});
});
