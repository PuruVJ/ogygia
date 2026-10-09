// The Observatory's share-link codec. The WHOLE workspace — the file map plus a little UI state —
// round-trips through the URL HASH, which browsers never send to a server, so a shared REPL (or one
// an agent hands the user) stays client-only. Encoded as `#<base64url(gzip(json))>` via the built-in
// CompressionStream; a CompressionStream-less runtime falls back to `#<base64url(utf8(json))>` and the
// decoder auto-detects (gzip magic bytes vs. raw JSON). The gzip format matches Node's zlib, so
// `ogygia mcp`'s link tool mints the same URLs.
//
// Pulled out of Observatory.svelte as PURE functions so the security-sensitive decode path (which
// takes untrusted URL input) can be unit-tested in Node — every global it uses (btoa/atob,
// TextEncoder, CompressionStream, Blob, Response) exists there too.

export type FileMap = Record<string, string>;
export type Workspace = { files: FileMap; active?: string; tab?: string; mode?: string; cursor?: number };

export const b64url_encode = (bytes: Uint8Array): string => {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const b64url_decode = (b64: string): Uint8Array => {
	const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
};

// A share link is untrusted input. Keep ONLY real `string → string` entries: a crafted or corrupt
// link could carry `{ "App.svelte": 42 }` or nested objects, which would hand CodeMirror a non-string
// doc and the compiler a non-string source — both throw. Also cap the count + total size so a giant
// map can't wedge the tab. Anything dropped just falls back to the demo.
export const MAX_HASH_FILES = 400;
export const MAX_HASH_BYTES = 4_000_000;
export function sanitize_files(map: unknown): FileMap {
	const out: FileMap = {};
	if (!map || typeof map !== 'object') return out;
	let n = 0;
	let bytes = 0;
	for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
		if (typeof k !== 'string' || !k.trim() || typeof v !== 'string') continue;
		bytes += k.length + v.length;
		if (++n > MAX_HASH_FILES || bytes > MAX_HASH_BYTES) break;
		out[k] = v;
	}
	return out;
}

export async function encode_hash(w: Workspace): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify({ f: w.files, a: w.active, t: w.tab, m: w.mode, c: w.cursor })
	);
	if (typeof CompressionStream === 'undefined') return '#' + b64url_encode(bytes);
	const gz = new Uint8Array(
		await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
	);
	return '#' + b64url_encode(gz);
}

export async function decode_hash(hash: string): Promise<Workspace | null> {
	const s = hash.replace(/^#/, '');
	if (!s) return null;
	try {
		// legacy `#code=`/`#files=` links (files-only)
		if (s.startsWith('code=') || s.startsWith('files=')) {
			const map = s.startsWith('code=')
				? JSON.parse(
						await new Response(
							new Blob([b64url_decode(s.slice(5)) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
						).text()
					)
				: JSON.parse(decodeURIComponent(s.slice(6)));
			const files = sanitize_files(map);
			return Object.keys(files).length ? { files } : null;
		}
		const raw = b64url_decode(s);
		const json =
			raw[0] === 0x1f && raw[1] === 0x8b && typeof DecompressionStream !== 'undefined'
				? await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
				: new TextDecoder().decode(raw);
		const obj = JSON.parse(json);
		if (!obj || typeof obj !== 'object') return null;
		// New shape carries UI state under `.f`; the very old shape was a bare file map.
		const files = sanitize_files(obj.f && typeof obj.f === 'object' ? obj.f : obj);
		if (!Object.keys(files).length) return null;
		return obj.f && typeof obj.f === 'object'
			? { files, active: obj.a, tab: obj.t, mode: obj.m, cursor: obj.c }
			: { files };
	} catch {
		/* malformed — caller falls back to the demo */
	}
	return null;
}
