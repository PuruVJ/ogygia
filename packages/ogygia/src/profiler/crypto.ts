/**
 * The `.ogp` codec — a profiler dump Brotli-compressed, then AES-256-GCM encrypted with the key.
 * A downloaded trace exposes server internals (source paths, component names, outbound URLs), so the
 * file can only be reopened by a profiler holding the same key. Node-only (dynamic `node:crypto` +
 * `node:zlib`), kept out of the edge-safe report renderer.
 *
 * Self-describing layout:  'OGP1' (4)  ·  salt (16)  ·  iv (12)  ·  ciphertext  ·  GCM tag (16)
 *
 * The AES key is `scrypt(secret, salt, 32)` — a fresh salt per file. `secret` is the profiler auth
 * secret; with none (dev) a fixed dev key is used so dev exports still open in dev.
 */

const MAGIC = [0x4f, 0x47, 0x50, 0x31]; // 'OGP1'
const DEV_KEY = 'ogygia-profiler-dev-key';

async function node() {
	const [crypto, zlib, util] = await Promise.all([
		import('node:crypto'),
		import('node:zlib'),
		import('node:util')
	]);
	const p = util.promisify;
	// The slow parts (KDF + Brotli) run ASYNC off the libuv threadpool — NEVER block the event loop
	// (the web server's single thread). AES-GCM itself is fast and stays inline.
	return {
		crypto,
		zlib,
		scrypt: p(crypto.scrypt) as (pw: string, salt: Uint8Array, len: number) => Promise<Buffer>,
		brotli: p(zlib.brotliCompress) as (buf: Uint8Array, opts?: unknown) => Promise<Buffer>,
		unbrotli: p(zlib.brotliDecompress) as (buf: Uint8Array) => Promise<Buffer>
	};
}

/** True when `bytes` starts with the `.ogp` magic (so import can tell it from legacy plain JSON). */
export function is_ogp(bytes: Uint8Array): boolean {
	return (
		bytes.length > 44 &&
		bytes[0] === MAGIC[0] &&
		bytes[1] === MAGIC[1] &&
		bytes[2] === MAGIC[2] &&
		bytes[3] === MAGIC[3]
	);
}

/** Compress + encrypt a dump object into `.ogp` bytes. Async — never blocks the event loop. */
export async function ogp_encode(dump: unknown, secret: string | undefined): Promise<Uint8Array> {
	const { crypto, zlib, scrypt, brotli } = await node();
	// Brotli (quality 5 — a good speed/ratio point for JSON this size) beats gzip on these traces.
	const gz = await brotli(Buffer.from(JSON.stringify(dump), 'utf8'), {
		params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 }
	});
	const salt = crypto.randomBytes(16);
	const iv = crypto.randomBytes(12);
	const key = await scrypt(secret || DEV_KEY, salt, 32);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
	const tag = cipher.getAuthTag(); // 16 bytes
	return Buffer.concat([Buffer.from(MAGIC), salt, iv, ct, tag]);
}

/**
 * Decrypt + gunzip `.ogp` bytes back to the dump object. Throws on a wrong key or a tampered file
 * (the GCM tag fails to verify) — the caller turns that into a "wrong key" message.
 */
export async function ogp_decode(bytes: Uint8Array, secret: string | undefined): Promise<unknown> {
	const { crypto, scrypt, unbrotli } = await node();
	const buf = Buffer.from(bytes);
	if (!is_ogp(buf)) throw new Error('not an .ogp file');
	const salt = buf.subarray(4, 20);
	const iv = buf.subarray(20, 32);
	const tag = buf.subarray(buf.length - 16);
	const ct = buf.subarray(32, buf.length - 16);
	const key = await scrypt(secret || DEV_KEY, salt, 32);
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	const gz = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on wrong key / tamper
	return JSON.parse((await unbrotli(gz)).toString('utf8'));
}
