/**
 * `recover_ogp_bytes` — undo the ways a `.ogp` gets mangled moving between machines through a text-y
 * channel (a Windows VDI → Mac copy, a chat, an editor re-save): a prepended UTF-8 BOM, or the whole
 * file base64-encoded. Both leave the raw bytes recoverable; a real `.ogp` is passed through untouched.
 */
import { describe, expect, it } from 'vitest';
import { is_ogp, recover_ogp_bytes } from '../src/profiler/crypto.js';

// A minimally-valid `.ogp` shape: the 'OGP1' magic + enough bytes to clear is_ogp's length gate (>44).
const ogp = new Uint8Array([0x4f, 0x47, 0x50, 0x31, ...Array.from({ length: 60 }, (_, i) => (i * 7) & 0xff)]);

describe('recover_ogp_bytes', () => {
	it('passes a real .ogp through unchanged', () => {
		expect(is_ogp(recover_ogp_bytes(ogp))).toBe(true);
		expect(recover_ogp_bytes(ogp)).toBe(ogp); // no-op returns the same reference
	});

	it('strips a prepended UTF-8 BOM', () => {
		const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...ogp]);
		expect(is_ogp(withBom)).toBe(false);
		expect(is_ogp(recover_ogp_bytes(withBom))).toBe(true);
	});

	it('decodes a base64-encoded file (round-trips byte-for-byte)', () => {
		const b64 = new TextEncoder().encode(Buffer.from(ogp).toString('base64'));
		expect(is_ogp(b64)).toBe(false);
		const recovered = recover_ogp_bytes(b64);
		expect(is_ogp(recovered)).toBe(true);
		expect([...recovered]).toEqual([...ogp]);
	});

	it('decodes base64 with wrapping newlines', () => {
		const wrapped = Buffer.from(ogp).toString('base64').replace(/(.{20})/g, '$1\n');
		const b64 = new TextEncoder().encode(wrapped);
		expect(is_ogp(recover_ogp_bytes(b64))).toBe(true);
	});

	it('leaves genuine garbage alone (import still rejects it)', () => {
		const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(is_ogp(recover_ogp_bytes(junk))).toBe(false);
	});
});
