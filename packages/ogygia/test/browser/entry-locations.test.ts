// ENTRY IDENTITY → LOCATION, the browser's half (runtime/entry-locations.ts), in a real browser: real
// module fetches, real 404s. An island's `entry` is its identity (the stable name every key uses); the
// file to import is its location (content-hashed). Every loader resolves through one map, and a load
// whose location fails falls back — once — to the identity fetched fresh.
//
// The map is module state shared by every test in this file: each test uses its own URLs.
import { describe, expect, test } from 'vitest';
import { entry_location, import_entry, island_entry_of, note_entry_location } from '../../src/runtime/entry-locations.js';
import { island_module_url, warm_island_module, is_warmed_module } from '../../src/runtime/region-endpoint-url.js';
import { register_island_graph } from '../../src/runtime/island-graph-preload.js';
import { encode_island_graph } from '../../src/island-graph.js';

const LOCATED = '/test/browser/fixtures/entry-located.ts';
const IDENTITY = '/test/browser/fixtures/entry-identity.ts';
const abs = (u: string) => new URL(u, location.href).href;
const requested = (part: string) => performance.getEntriesByType('resource').filter((r) => r.name.includes(part));

describe('the map', () => {
	test('an unknown entry resolves to itself', () => {
		expect(entry_location('/u/og-region.aaaaaaaaaaaa.js')).toBeUndefined();
		expect(island_module_url('/u/og-region.aaaaaaaaaaaa.js')).toBe('/u/og-region.aaaaaaaaaaaa.js');
	});

	test('a noted entry resolves to its location, absolute', () => {
		note_entry_location('/n/og-region.bbbbbbbbbbbb.js', '/n/chunks/Ab12Cd34.js');
		expect(island_module_url('/n/og-region.bbbbbbbbbbbb.js')).toBe(abs('/n/chunks/Ab12Cd34.js'));
	});

	test('relative pairs resolve against the document they were read from', () => {
		const doc = 'http://other.test/deep/page/';
		note_entry_location('./_app/immutable/og-region.cccccccccccc.js', './_app/immutable/chunks/X.js', doc);
		expect(entry_location('http://other.test/deep/page/_app/immutable/og-region.cccccccccccc.js')).toBe('http://other.test/deep/page/_app/immutable/chunks/X.js');
		// …and the same identity written root-relative on that origin is the same key
		expect(entry_location('/deep/page/_app/immutable/og-region.cccccccccccc.js', doc)).toBe('http://other.test/deep/page/_app/immutable/chunks/X.js');
	});

	test('nothing is noted for a missing location, or one that is the identity itself', () => {
		note_entry_location('/m/og-region.dddddddddddd.js', null);
		note_entry_location('/m/og-region.dddddddddddd.js', '');
		note_entry_location('/m/og-region.dddddddddddd.js', '/m/og-region.dddddddddddd.js');
		expect(entry_location('/m/og-region.dddddddddddd.js')).toBeUndefined();
		note_entry_location(null, '/m/chunks/Z.js');
		expect(entry_location('')).toBeUndefined();
	});

	test('the latest location wins (a page from a newer build, mid-session)', () => {
		note_entry_location('/w/og-region.eeeeeeeeeeee.js', '/w/chunks/Old11111.js');
		note_entry_location('/w/og-region.eeeeeeeeeeee.js', '/w/chunks/New22222.js');
		expect(island_module_url('/w/og-region.eeeeeeeeeeee.js')).toBe(abs('/w/chunks/New22222.js'));
	});

	test('an island element: its identity read, its `src` noted on the way', () => {
		const el = document.createElement('ogygia-region');
		el.setAttribute('entry', '/e/og-region.ffffffffffff.js');
		el.setAttribute('src', '/e/chunks/Ef56Gh78.js');
		expect(island_entry_of(el)).toBe('/e/og-region.ffffffffffff.js');
		expect(island_module_url('/e/og-region.ffffffffffff.js')).toBe(abs('/e/chunks/Ef56Gh78.js'));
		// no `src` (a page from before hashing, the dev server): the identity, nothing noted
		const bare = document.createElement('ogygia-region');
		bare.setAttribute('entry', '/e/og-region.000000000001.js');
		expect(island_entry_of(bare)).toBe('/e/og-region.000000000001.js');
		expect(entry_location('/e/og-region.000000000001.js')).toBeUndefined();
		expect(island_entry_of(document.createElement('ogygia-region'))).toBeNull();
	});

	test('an island graph script carries locations for entries no element has (its `s` map)', () => {
		const doc = 'http://graph.test/p/';
		const text = encode_island_graph(new Map([['./i/og-region.000000000002.js', ['./i/chunks/Dep.js']]]), new Map([['/i/og-region.000000000003.js', './i/chunks/Snip.js']]));
		register_island_graph(text, doc);
		expect(entry_location('http://graph.test/i/og-region.000000000003.js')).toBe('http://graph.test/p/i/chunks/Snip.js');
		// a graph without `s` (an older server) notes nothing
		register_island_graph(encode_island_graph(new Map([['/i/og-region.000000000004.js', []]])), doc);
		expect(entry_location('http://graph.test/i/og-region.000000000004.js')).toBeUndefined();
	});
});

describe('import_entry: the location, then the identity fresh, once', () => {
	test('a known location is what gets imported', async () => {
		const identity = '/test/browser/fixtures/entry-identity.ts?t=1';
		note_entry_location(identity, LOCATED + '?t=1');
		const m = await import_entry<{ default: string }>(identity);
		expect(m.default).toBe('located');
		expect(requested('entry-identity.ts?t=1')).toHaveLength(0);
	});

	test('the location failing, the identity is fetched fresh (a page that outlived its build)', async () => {
		const identity = IDENTITY + '?t=2';
		note_entry_location(identity, '/test/browser/fixtures/gone-Aa11Bb22.js');
		const m = await import_entry<{ default: string }>(identity);
		expect(m.default).toBe('identity');
		// fresh: past any cache, by a query the stable name ignores
		const fresh = requested('entry-identity.ts?t=2&og-fresh=');
		expect(fresh.length).toBe(1);
	});

	test('no location known: the identity itself, and its failure stands (no retry)', async () => {
		await expect(import_entry('/test/browser/fixtures/gone-Cc33Dd44.js')).rejects.toThrow();
		expect(requested('gone-Cc33Dd44.js?og-fresh')).toHaveLength(0);
	});

	test('both gone: exactly one retry, then the error stands (never a loop)', async () => {
		const identity = '/test/browser/fixtures/gone-Ee55Ff66.js';
		note_entry_location(identity, '/test/browser/fixtures/gone-Gg77Hh88.js');
		await expect(import_entry(identity)).rejects.toThrow();
		expect(requested('gone-Ee55Ff66.js?og-fresh=')).toHaveLength(1);
		expect(requested('gone-Gg77Hh88.js')).toHaveLength(1);
	});

	test('an explicit url wins over the map (the caller already resolved it)', async () => {
		const identity = IDENTITY + '?t=5';
		note_entry_location(identity, '/test/browser/fixtures/gone-Ii99Jj00.js');
		const m = await import_entry<{ default: string }>(identity, LOCATED + '?t=5');
		expect(m.default).toBe('located');
	});
});

describe('the warmer goes to the location', () => {
	test('warming an identity fetches its location, and dedupes by it', async () => {
		const identity = IDENTITY + '?t=6';
		note_entry_location(identity, LOCATED + '?t=6');
		warm_island_module(identity);
		await expect.poll(() => requested('entry-located.ts?t=6').length, { timeout: 5000 }).toBe(1);
		expect(requested('entry-identity.ts?t=6')).toHaveLength(0);
		expect(is_warmed_module(identity)).toBe(true);
		expect(is_warmed_module(LOCATED + '?t=6')).toBe(true);
		warm_island_module(identity);
		await new Promise((r) => setTimeout(r, 100));
		expect(requested('entry-located.ts?t=6')).toHaveLength(1);
	});
});
