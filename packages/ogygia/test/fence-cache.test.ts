import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fence_key, fence_cache_get, fence_cache_set, __set_fence_cache_dir } from '../src/content/markdown/fence-cache.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-fence-'));
__set_fence_cache_dir(tmp);
afterAll(() => {
	__set_fence_cache_dir(undefined); // re-probe for anything after us
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fence cache', () => {
	it('keys are stable and input-sensitive', () => {
		const a = fence_key(['cfg', 'js', '', 'let x = 1;']);
		expect(fence_key(['cfg', 'js', '', 'let x = 1;'])).toBe(a);
		expect(fence_key(['cfg', 'ts', '', 'let x = 1;'])).not.toBe(a);
		expect(fence_key(['cfg', 'js', '', 'let x = 2;'])).not.toBe(a);
		// part boundaries can't collide ('ab','c' vs 'a','bc')
		expect(fence_key(['ab', 'c'])).not.toBe(fence_key(['a', 'bc']));
	});

	it('set/get round-trip; miss → null', () => {
		const k = fence_key(['round', 'trip']);
		expect(fence_cache_get(k)).toBeNull();
		fence_cache_set(k, { html: '<pre>cached</pre>' });
		expect(fence_cache_get(k)).toEqual({ html: '<pre>cached</pre>' });
	});

	it('a disabled cache (dir null) is silent', () => {
		__set_fence_cache_dir(null);
		fence_cache_set(fence_key(['x']), { html: 'y' }); // no throw
		expect(fence_cache_get(fence_key(['x']))).toBeNull();
		__set_fence_cache_dir(tmp);
	});
});
