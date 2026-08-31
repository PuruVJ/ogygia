/**
 * The `#fragment` permalink codec — a zero-knowledge, zero-infra way to SHARE a profiler report as a
 * URL instead of an `.ogp` file. The whole encrypted report rides in the URL fragment (`…/view#<blob>`),
 * which browsers NEVER send to any server — so the report lives entirely in the link (permanent, no
 * storage) and neither the profiler's server nor anyone else sees the plaintext or the password.
 *
 * BROWSER-NATIVE by necessity (encode runs in the sharer's browser, decode in the recipient's): JS has
 * no Brotli, so this uses **gzip** (`CompressionStream`) + **AES-256-GCM** with a key from **PBKDF2**
 * (Web Crypto — the Node `.ogp` path uses scrypt, which `crypto.subtle` can't do). Slightly larger than
 * the Brotli `.ogp`, but portable to Chrome / Firefox / Safari alike.
 *
 * Layout (pre-base64url):  'OGL1' (4) · salt (16) · iv (12) · AES-GCM ciphertext+tag.
 */

const MAGIC = new Uint8Array([0x4f, 0x47, 0x4c, 0x31]); // 'OGL1'
const PBKDF2_ITERS = 210_000; // OWASP 2023 floor for PBKDF2-SHA256
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

// lib.dom types `BufferSource` / `BlobPart` as strictly `ArrayBuffer`-backed, but a `Uint8Array` is
// generically `Uint8Array<ArrayBufferLike>` (which admits `SharedArrayBuffer`). Every array here is
// plain-`ArrayBuffer`-backed at runtime, so these narrowings are sound — they just satisfy the DOM
// signatures without threading `<ArrayBuffer>` type params through subarray()/getRandomValues().
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;
const part = (u: Uint8Array): BlobPart => u as unknown as BlobPart;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream('gzip');
	const blob = await new Response(new Blob([part(bytes)]).stream().pipeThrough(cs)).arrayBuffer();
	return new Uint8Array(blob);
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream('gzip');
	const blob = await new Response(new Blob([part(bytes)]).stream().pipeThrough(ds)).arrayBuffer();
	return new Uint8Array(blob);
}

async function derive_key(password: string, salt: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
	const base = await subtle().importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveKey']
	);
	return subtle().deriveKey(
		{ name: 'PBKDF2', salt: buf(salt), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		[usage]
	);
}

/** base64url (no padding) — URL-fragment safe (`+/=` → `-_` dropped). */
function b64url_encode(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64url_decode(str: string): Uint8Array {
	const s = str.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(s + '==='.slice((s.length + 3) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Encrypt a report dump for a permalink: gzip → AES-GCM(PBKDF2(password)) → base64url. */
export async function encode_permalink(dump: unknown, password: string): Promise<string> {
	const plain = await gzip(new TextEncoder().encode(JSON.stringify(dump)));
	const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
	const key = await derive_key(password, salt, 'encrypt');
	const ct = new Uint8Array(
		await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(plain))
	);
	const out = new Uint8Array(MAGIC.length + salt.length + iv.length + ct.length);
	out.set(MAGIC, 0);
	out.set(salt, MAGIC.length);
	out.set(iv, MAGIC.length + salt.length);
	out.set(ct, MAGIC.length + salt.length + iv.length);
	return b64url_encode(out);
}

/** Reverse of {@link encode_permalink}. Throws on a wrong password / tampered blob (GCM tag fails). */
export async function decode_permalink(blob: string, password: string): Promise<unknown> {
	const bytes = b64url_decode(blob);
	if (
		bytes.length < 4 ||
		bytes[0] !== 0x4f ||
		bytes[1] !== 0x47 ||
		bytes[2] !== 0x4c ||
		bytes[3] !== 0x31
	)
		throw new Error('not an ogygia share link');
	const salt = bytes.subarray(4, 20);
	const iv = bytes.subarray(20, 32);
	const ct = bytes.subarray(32);
	const key = await derive_key(password, salt, 'decrypt');
	const plain = new Uint8Array(
		await subtle().decrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(ct))
	);
	return JSON.parse(new TextDecoder().decode(await gunzip(plain)));
}

/** All-WebKit browsers (desktop Safari + EVERY iOS browser) hard-error past ~80 K URL chars, too small
 *  for a real report — so universal links are disabled there. Chromium (~2 MB) and Firefox handle it. */
export function is_webkit_capped(): boolean {
	const ua = navigator.userAgent;
	const ios = /iP(hone|ad|od)/.test(ua);
	const safari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(ua);
	return ios || safari;
}

/** Chromium tops out at a 2 MB URL; keep a safe margin. Fragment chars ≈ blob length (all ASCII). */
export const MAX_PERMALINK_CHARS = 1_500_000;
