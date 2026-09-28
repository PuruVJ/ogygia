// The exact byte ledger: each file counted once on the page, each island's "only it" is what no
// other island needs, the runtime kept apart, a file not loaded yet is cold (not zero).
import { expect, test } from 'vitest';
import { byte_ledger } from '../src/devtools/bytes.js';

const u = (f: string) => `http://x/_app/${f}`;
const graph = new Map([
	[u('a.js'), [u('shared.js'), u('big-a.js'), u('rt.js')]],
	[u('b.js'), [u('shared.js')]],
	[u('c.js'), [u('shared.js'), u('c-dep.js')]]
]);
const sizes: Record<string, number> = { 'a.js': 1000, 'shared.js': 5000, 'big-a.js': 40_000, 'rt.js': 9000, 'b.js': 800, 'run.js': 20_000 };
const size = (url: string) => {
	const f = url.slice(url.lastIndexOf('/') + 1);
	return f in sizes ? { wire: sizes[f], raw: sizes[f] * 3 } : null;
};
const islands = [
	{ entry: u('a.js'), name: 'A', kind: 'island', wake: 'load', count: 1 },
	{ entry: u('b.js'), name: 'B', kind: 'island', wake: 'load', count: 2 },
	{ entry: u('c.js'), name: 'C', kind: 'island', wake: 'visible', count: 1 }
];

test('each file once, what only each island needs, the shared files with their users', () => {
	const l = byte_ledger(islands, graph, size, [u('run.js'), u('rt.js')]);
	const a = l.rows.find((r) => r.name === 'A')!;
	// A: its entry + big-a only it needs; shared.js with B and C; rt.js is the runtime's, not A's
	expect(a).toMatchObject({ files: 3, wire: 46_000, unique: 41_000, shared: 5000, cold: 0 });
	expect(l.rows[0].name).toBe('A'); // the most only-it bytes first
	const c = l.rows.find((r) => r.name === 'C')!;
	expect(c).toMatchObject({ files: 3, cold: 2, wire: 5000, unique: 0 }); // asleep: its entry and dep not loaded
	// the page: a, shared, big-a, b, c (cold), c-dep (cold), run, rt — each once
	expect(l.page).toEqual({ files: 8, wire: 1000 + 5000 + 40_000 + 800 + 20_000 + 9000, raw: (1000 + 5000 + 40_000 + 800 + 20_000 + 9000) * 3, cold: 2 });
	expect(l.runtime).toEqual({ files: 2, wire: 29_000 });
	expect(l.shared).toEqual([{ url: u('shared.js'), wire: 5000, users: ['A', 'B', 'C'] }]);
});

test("an island's id from a dev entry and from a built one (the names key the bare id)", async () => {
	const { island_id } = await import('../src/devtools/regions.js');
	expect(island_id('/@id/__x00__virtual:ogygia/island/415a42fa7fbd.js')).toBe('415a42fa7fbd');
	expect(island_id('./_app/immutable/og-region.24fa20edb0cb.js')).toBe('24fa20edb0cb');
	expect(island_id('https://cdn.example/_app/immutable/og-region.24fa20edb0cb.js?v=1')).toBe('24fa20edb0cb');
});

test('two copies of an island are one row (their files once)', () => {
	const l = byte_ledger([...islands, { ...islands[1] }], graph, size, []);
	expect(l.rows.filter((r) => r.name === 'B')).toHaveLength(1);
});
