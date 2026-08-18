import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RegionStore } from '../src/content/region-store.js';
import { __set_build_cache_root } from '../src/build-cache.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-region-store-'));
__set_build_cache_root(tmp);
afterAll(() => {
	__set_build_cache_root(undefined);
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('RegionStore', () => {
	it('round-trips a serialized region under its namespace', () => {
		const store = new RegionStore('docs');
		const key = store.key(['sig', 'file.md', '# hello']);
		expect(store.get(key)).toBeNull();
		store.set(key, { html: '<h1>hello</h1>' });
		expect(store.get(key)).toEqual({ html: '<h1>hello</h1>' });
		expect(fs.existsSync(path.join(tmp, 'docs', key + '.json'))).toBe(true);
	});

	it('addresses are stable, input-sensitive, and version-sensitive', () => {
		const a = new RegionStore('x');
		expect(a.key(['p'])).toBe(a.key(['p']));
		expect(a.key(['p'])).not.toBe(a.key(['q']));
		expect(a.key(['a', 'b'])).not.toBe(a.key(['ab'])); // separator-safe
		expect(new RegionStore('x', '2').key(['p'])).not.toBe(a.key(['p']));
	});

	it('namespaces are disjoint', () => {
		const docs = new RegionStore('ns-a');
		const fences = new RegionStore('ns-b');
		const key = docs.key(['same']);
		docs.set(key, { html: 'A' });
		expect(fences.get(key)).toBeNull();
	});

	it('carries the islands field when present', () => {
		const store = new RegionStore('with-islands');
		const key = store.key(['k']);
		store.set(key, { html: '<div/>', islands: [{ module: 'x', wake: 'load' }] });
		expect(store.get(key)!.islands).toEqual([{ module: 'x', wake: 'load' }]);
	});
});
