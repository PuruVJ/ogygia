/**
 * A tiny, self-contained `node:crypto` shim for the Observatory worker — just enough for the ogygia
 * transform, which only calls `createHash('md5').update(str).digest('hex')` to mint region ids. Avoids
 * crypto-browserify (which drags in `createRequire`/`node:child_process` and won't run in a worker).
 * The md5 here is the standard algorithm, so region ids match the real Node build byte-for-byte.
 */

/* eslint-disable no-bitwise */
function md5_hex(input: string): string {
	// UTF-8 encode.
	const bytes = new TextEncoder().encode(input);
	const n = bytes.length;
	// Pad to 512-bit blocks.
	const withOne = n + 1;
	const blocks = Math.ceil((withOne + 8) / 64);
	const total = blocks * 64;
	const buf = new Uint8Array(total);
	buf.set(bytes);
	buf[n] = 0x80;
	const bitLen = n * 8;
	// 64-bit little-endian length (low 32 bits are enough for our short inputs, but write both).
	const dv = new DataView(buf.buffer);
	dv.setUint32(total - 8, bitLen >>> 0, true);
	dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

	const s = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
		14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
	];
	const K = new Int32Array(64);
	for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

	let a0 = 0x67452301 | 0;
	let b0 = 0xefcdab89 | 0;
	let c0 = 0x98badcfe | 0;
	let d0 = 0x10325476 | 0;

	const M = new Int32Array(16);
	for (let block = 0; block < blocks; block++) {
		for (let i = 0; i < 16; i++) M[i] = dv.getUint32(block * 64 + i * 4, true);
		let A = a0;
		let B = b0;
		let C = c0;
		let D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number;
			let g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}
			F = (F + A + K[i] + M[g]) | 0;
			A = D;
			D = C;
			C = B;
			const rot = (F << s[i]) | (F >>> (32 - s[i]));
			B = (B + rot) | 0;
		}
		a0 = (a0 + A) | 0;
		b0 = (b0 + B) | 0;
		c0 = (c0 + C) | 0;
		d0 = (d0 + D) | 0;
	}

	const out = new Uint8Array(16);
	const odv = new DataView(out.buffer);
	odv.setUint32(0, a0 >>> 0, true);
	odv.setUint32(4, b0 >>> 0, true);
	odv.setUint32(8, c0 >>> 0, true);
	odv.setUint32(12, d0 >>> 0, true);
	let hex = '';
	for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
	return hex;
}

class Hash {
	#algo: string;
	#data = '';
	constructor(algo: string) {
		this.#algo = algo;
	}
	update(data: string): this {
		this.#data += data;
		return this;
	}
	digest(enc: string): string {
		if (this.#algo !== 'md5')
			throw new Error(`[observatory] crypto shim only implements md5 (got '${this.#algo}')`);
		if (enc !== 'hex') throw new Error(`[observatory] crypto shim only supports 'hex' (got '${enc}')`);
		return md5_hex(this.#data);
	}
}

export function createHash(algo: string): Hash {
	return new Hash(algo);
}

export default { createHash };
