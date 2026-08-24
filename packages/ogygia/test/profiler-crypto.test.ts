import { describe, expect, it } from 'vitest';
import { ogp_encode, ogp_decode, is_ogp } from '../dist/profiler/crypto.js';

// A dump-shaped payload; the `<script>` proves nothing in the value trips the codec.
const sample = {
	kind: 'ogygia-profiler-dump',
	version: 1,
	meta: { id: 'abc123', node: 'v22' },
	analysis: { nodes: [1, 2, 3], busy_ms: 42 },
	extras: { net: [{ url: '/x', ms: 3 }] },
	note: 'exposes internals </script>'
};

describe('.ogp codec (Brotli + AES-GCM)', () => {
	it('round-trips with the right key', async () => {
		const bytes = await ogp_encode(sample, 'secret-key');
		expect(is_ogp(bytes)).toBe(true);
		expect(await ogp_decode(bytes, 'secret-key')).toEqual(sample);
	});

	it('opens in ANY profiler that has the same key (cross-instance import)', async () => {
		const bytes = await ogp_encode(sample, 'shared-key');
		// a "different profiler" is just another decode with that key
		expect(await ogp_decode(bytes, 'shared-key')).toEqual(sample);
	});

	it('fails on the wrong key (GCM tag rejects it)', async () => {
		const bytes = await ogp_encode(sample, 'right');
		await expect(ogp_decode(bytes, 'wrong')).rejects.toThrow();
	});

	it('each export has its own salt + iv (ciphertext differs for the same input)', async () => {
		const a = await ogp_encode(sample, 'k');
		const b = await ogp_encode(sample, 'k');
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	it('is_ogp rejects non-.ogp bytes (plain JSON, random)', () => {
		expect(is_ogp(new Uint8Array([1, 2, 3, 4, 5]))).toBe(false);
		expect(is_ogp(new TextEncoder().encode('{"kind":"ogygia-profiler-dump"}'))).toBe(false);
	});

	it('dev fallback: encodes/decodes with no secret', async () => {
		const bytes = await ogp_encode(sample, undefined);
		expect(await ogp_decode(bytes, undefined)).toEqual(sample);
	});
});
