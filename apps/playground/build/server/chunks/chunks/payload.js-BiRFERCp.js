//#region \0virtual:ogygia/secret
var secret = process.env.OGYGIA_SECRET || "aa22468bdd700a89dc0d09f195208f18e3e7cd11607623b2023f714f8f3e71d8";
//#endregion
//#region ../packages/ogygia/dist/server/hmac.js
var K = [];
(() => {
	const primes = [];
	let n = 2;
	while (primes.length < 64) {
		let is_prime = true;
		for (let d = 2; d * d <= n; d++) if (n % d === 0) {
			is_prime = false;
			break;
		}
		if (is_prime) primes.push(n);
		n++;
	}
	for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.cbrt(primes[i]) % 1 * 2 ** 32) | 0;
})();
function rotr(x, n) {
	return x >>> n | x << 32 - n;
}
/** SHA-256 over a byte array -> 32-byte Uint8Array. */
function sha256(bytes) {
	const H = [
		1779033703,
		3144134277,
		1013904242,
		2773480762,
		1359893119,
		2600822924,
		528734635,
		1541459225
	];
	const bit_len = bytes.length * 8;
	const with_len = (bytes.length + 8 >> 6) + 1 << 6;
	const padded = new Uint8Array(with_len);
	padded.set(bytes);
	padded[bytes.length] = 128;
	const dv = new DataView(padded.buffer);
	dv.setUint32(with_len - 4, bit_len >>> 0, false);
	dv.setUint32(with_len - 8, Math.floor(bit_len / 2 ** 32), false);
	const w = /* @__PURE__ */ new Int32Array(64);
	for (let off = 0; off < with_len; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
			w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = e & f ^ ~e & g;
			const t1 = h + S1 + ch + K[i] + w[i] | 0;
			const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
			h = g;
			g = f;
			f = e;
			e = d + t1 | 0;
			d = c;
			c = b;
			b = a;
			a = t1 + t2 | 0;
		}
		H[0] = H[0] + a | 0;
		H[1] = H[1] + b | 0;
		H[2] = H[2] + c | 0;
		H[3] = H[3] + d | 0;
		H[4] = H[4] + e | 0;
		H[5] = H[5] + f | 0;
		H[6] = H[6] + g | 0;
		H[7] = H[7] + h | 0;
	}
	const out = /* @__PURE__ */ new Uint8Array(32);
	const odv = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i] >>> 0, false);
	return out;
}
function utf8(str) {
	return new TextEncoder().encode(str);
}
function to_hex(bytes) {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}
/**
* HMAC-SHA256(key, message) -> hex string.
* @param {string} key
* @param {string} message
* @returns {string}
*/
function hmacSha256(key, message) {
	const block_size = 64;
	let key_bytes = utf8(key);
	if (key_bytes.length > block_size) key_bytes = sha256(key_bytes);
	const padded = new Uint8Array(block_size);
	padded.set(key_bytes);
	const ipad = new Uint8Array(block_size);
	const opad = new Uint8Array(block_size);
	for (let i = 0; i < block_size; i++) {
		ipad[i] = padded[i] ^ 54;
		opad[i] = padded[i] ^ 92;
	}
	const msg = utf8(message);
	const inner = new Uint8Array(block_size + msg.length);
	inner.set(ipad);
	inner.set(msg, block_size);
	const inner_hash = sha256(inner);
	const outer = new Uint8Array(block_size + inner_hash.length);
	outer.set(opad);
	outer.set(inner_hash, block_size);
	return to_hex(sha256(outer));
}
/**
* @param {string} secret
* @param {string} payload
* @returns {string} hex signature
*/
function sign(secret, payload) {
	return hmacSha256(secret, payload);
}
/**
* Constant-time-ish comparison + recompute. Rejects tampered payloads.
* @param {string} secret
* @param {string} payload
* @param {string} sig
* @returns {boolean}
*/
function verify(secret, payload, sig) {
	if (typeof sig !== "string" || sig.length !== 64) return false;
	const expected = hmacSha256(secret, payload);
	if (expected.length !== sig.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0;
}
//#endregion
//#region ../packages/ogygia/dist/server/payload.js
/**
* @param {string} str utf-8 string
* @returns {string} base64url (no padding)
*/
function b64urlEncode(str) {
	const bytes = new TextEncoder().encode(str);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}
/**
* @param {string} b64 base64url string
* @returns {string} utf-8 string
*/
function b64urlDecode(b64) {
	const norm = b64.replaceAll("-", "+").replaceAll("_", "/");
	const bin = atob(norm);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

export { b64urlEncode as a, b64urlDecode as b, sign as c, secret as s, verify as v };
//# sourceMappingURL=payload.js-BiRFERCp.js.map
