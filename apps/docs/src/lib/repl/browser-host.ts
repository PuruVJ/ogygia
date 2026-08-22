/**
 * The Observatory's BROWSER host for ogygia's compiler/content seam ({@link CompilerHost}). Installed
 * once via `set_host` so everything that reaches for `fs`/`path`/`createHash` through the seam —
 * `transformHost` region ids (md5), the content `RegionStore`/fence keys (sha256), `BuildCache` — runs
 * in the worker with NO `node:*` and no reliance on Vite incidentally polyfilling `node:crypto`.
 *
 * `fs` is a throwing stub: the only browser-active reader of `host.fs` is `BuildCache`, which we disable
 * (`__set_build_cache_root(null)`) — a REPL recompiles one file, it needs no on-disk cache. The hashes
 * are vendored + unit-tested byte-for-byte against `node:crypto` (see `browser-host.test.mjs`).
 */
import path from 'path-browserify';
import type { CompilerHost } from 'ogygia/internal/compiler-browser';
// The lean browser entry exports only `CompilerHost`; derive the member types we annotate from it.
type HostFs = CompilerHost['fs'];
type HostHasher = ReturnType<CompilerHost['crypto']['createHash']>;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ── SHA-256 (FIPS 180-4) over bytes → lowercase hex ──────────────────────────────────────────────
const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function sha256_hex(msg: Uint8Array): string {
	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	]);
	const l = msg.length;
	const bit_len = l * 8;
	const with_one = l + 1;
	const pad = (56 - (with_one % 64) + 64) % 64;
	const total = with_one + pad + 8;
	const m = new Uint8Array(total);
	m.set(msg);
	m[l] = 0x80;
	const dv = new DataView(m.buffer);
	dv.setUint32(total - 8, Math.floor(bit_len / 0x100000000));
	dv.setUint32(total - 4, bit_len >>> 0);

	const w = new Uint32Array(64);
	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
		}
		h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
		h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
	}
	let out = '';
	for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
	return out;
}

// ── MD5 (RFC 1321) over bytes → lowercase hex ────────────────────────────────────────────────────
const MD5_S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
// T[i] = floor(abs(sin(i+1)) * 2^32) — the RFC 1321 constants (hardcoded to avoid any sin() drift).
const MD5_T = new Uint32Array([
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
	0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
	0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
	0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
	0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
	0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
	0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
	0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
]);
const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

function md5_hex(msg: Uint8Array): string {
	const l = msg.length;
	const with_one = l + 1;
	const pad = (56 - (with_one % 64) + 64) % 64;
	const total = with_one + pad + 8;
	const m = new Uint8Array(total);
	m.set(msg);
	m[l] = 0x80;
	const dv = new DataView(m.buffer);
	const bit_len = l * 8;
	dv.setUint32(total - 8, bit_len >>> 0, true); // md5 length is little-endian
	dv.setUint32(total - 4, Math.floor(bit_len / 0x100000000), true);

	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	const x = new Uint32Array(16);
	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) x[i] = dv.getUint32(off + i * 4, true);
		let A = a0, B = b0, C = c0, D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number, g: number;
			if (i < 16) { F = (B & C) | (~B & D); g = i; }
			else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
			else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
			else { F = C ^ (B | ~D); g = (7 * i) & 15; }
			F = (F + A + MD5_T[i] + x[g]) >>> 0;
			A = D; D = C; C = B;
			B = (B + rotl(F, MD5_S[i])) >>> 0;
		}
		a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
	}
	const le = (n: number): string => {
		let s = '';
		for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
		return s;
	};
	return le(a0) + le(b0) + le(c0) + le(d0);
}

/** node:crypto-compatible `createHash(algo).update(str).digest('hex')` for the two algos the seam uses
 *  in a browser realm: `md5` (region ids) and `sha256` (region/fence keys). */
export function createHash(algo: string): HostHasher {
	let buf = '';
	const hasher: HostHasher = {
		update(data: string) {
			buf += data;
			return hasher;
		},
		digest() {
			const bytes = utf8(buf);
			return algo === 'md5' ? md5_hex(bytes) : sha256_hex(bytes);
		}
	};
	return hasher;
}

/** A host `fs` that refuses every op — the only browser-active reader is BuildCache, which we disable,
 *  so any access here is a bug we'd rather see loudly than silently mis-serve. */
function throwing_fs(): HostFs {
	const nope = (): never => {
		throw new Error('[observatory] host.fs is unavailable in the browser (BuildCache is disabled)');
	};
	return {
		readFileSync: nope, existsSync: () => false, readdirSync: nope, statSync: nope,
		globSync: () => [], writeFileSync: () => {}, mkdirSync: nope, rmSync: () => {}, renameSync: nope
	};
}

/** The browser CompilerHost — install with `set_host(make_browser_host())`. */
export function make_browser_host(): CompilerHost {
	return {
		fs: throwing_fs(),
		path: path as unknown as CompilerHost['path'],
		crypto: { createHash }
	};
}
