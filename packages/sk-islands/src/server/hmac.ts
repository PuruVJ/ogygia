// Dependency-free, synchronous HMAC-SHA256 over UTF-8 strings, returning a hex digest.
//
// Deliberately NOT node:crypto: this module is imported by ServerIsland.svelte (which the
// Svelte/vite pipeline may also type-check or bundle for a client build on a csr=true page)
// and by the hooks endpoint. A pure-JS implementation stays portable and side-effect-free,
// so the ONLY thing that must be kept server-side is the secret (see virtual:sk-islands/secret).

const K = /** @type {number[]} */ ([]);
(() => {
	// SHA-256 round constants: first 32 bits of the fractional parts of the cube roots of
	// the first 64 primes.
	const primes = [];
	let n = 2;
	while (primes.length < 64) {
		let isPrime = true;
		for (let d = 2; d * d <= n; d++) {
			if (n % d === 0) {
				isPrime = false;
				break;
			}
		}
		if (isPrime) primes.push(n);
		n++;
	}
	for (let i = 0; i < 64; i++) {
		K[i] = Math.floor((Math.cbrt(primes[i]) % 1) * 2 ** 32) | 0;
	}
})();

function rotr(x, n) {
	return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over a byte array -> 32-byte Uint8Array. */
function sha256(bytes) {
	const H = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
		0x5be0cd19
	];

	const bitLen = bytes.length * 8;
	// pad: append 0x80, then zeros, then 64-bit big-endian length
	const withLen = (((bytes.length + 8) >> 6) + 1) << 6;
	const padded = new Uint8Array(withLen);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	// 64-bit length; JS bit ops are 32-bit so only fill the low 32 bits (fine for our inputs)
	const dv = new DataView(padded.buffer);
	dv.setUint32(withLen - 4, bitLen >>> 0, false);
	dv.setUint32(withLen - 8, Math.floor(bitLen / 2 ** 32), false);

	const w = new Int32Array(64);
	for (let off = 0; off < withLen; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) | 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		H[0] = (H[0] + a) | 0;
		H[1] = (H[1] + b) | 0;
		H[2] = (H[2] + c) | 0;
		H[3] = (H[3] + d) | 0;
		H[4] = (H[4] + e) | 0;
		H[5] = (H[5] + f) | 0;
		H[6] = (H[6] + g) | 0;
		H[7] = (H[7] + h) | 0;
	}

	const out = new Uint8Array(32);
	const odv = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i] >>> 0, false);
	return out;
}

function utf8(str) {
	return new TextEncoder().encode(str);
}

function toHex(bytes) {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

/**
 * HMAC-SHA256(key, message) -> hex string.
 * @param {string} key
 * @param {string} message
 * @returns {string}
 */
export function hmacSha256(key, message) {
	const blockSize = 64;
	let keyBytes = utf8(key);
	if (keyBytes.length > blockSize) keyBytes = sha256(keyBytes);
	const padded = new Uint8Array(blockSize);
	padded.set(keyBytes);
	const ipad = new Uint8Array(blockSize);
	const opad = new Uint8Array(blockSize);
	for (let i = 0; i < blockSize; i++) {
		ipad[i] = padded[i] ^ 0x36;
		opad[i] = padded[i] ^ 0x5c;
	}
	const msg = utf8(message);
	const inner = new Uint8Array(blockSize + msg.length);
	inner.set(ipad);
	inner.set(msg, blockSize);
	const innerHash = sha256(inner);
	const outer = new Uint8Array(blockSize + innerHash.length);
	outer.set(opad);
	outer.set(innerHash, blockSize);
	return toHex(sha256(outer));
}

/**
 * @param {string} secret
 * @param {string} payload
 * @returns {string} hex signature
 */
export function sign(secret, payload) {
	return hmacSha256(secret, payload);
}

/**
 * Constant-time-ish comparison + recompute. Rejects tampered payloads.
 * @param {string} secret
 * @param {string} payload
 * @param {string} sig
 * @returns {boolean}
 */
export function verify(secret, payload, sig) {
	if (typeof sig !== 'string' || sig.length !== 64) return false;
	const expected = hmacSha256(secret, payload);
	if (expected.length !== sig.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0;
}
