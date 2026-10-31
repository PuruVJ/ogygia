// URL-safe base64 for the (devalue-stringified) server-island props payload. Server-only: minted per
// hole per page, decoded per hole request. Node's native base64url when there is a `Buffer` (one
// call, no per-character string building); the portable TextEncoder + btoa path otherwise (an edge
// runtime without it). Both give the same unpadded output.

type BufferLike = {
	from(input: string, encoding?: string): { toString(encoding?: string): string };
};
const NodeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;

export class B64Url {
	/** @param str utf-8 string */
	static encode(str: string): string {
		if (NodeBuffer) return NodeBuffer.from(str, 'utf8').toString('base64url');
		const bytes = new TextEncoder().encode(str);
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
	}

	/** @param b64 base64url string (decoded only after its MAC verified) */
	static decode(b64: string): string {
		if (NodeBuffer) return NodeBuffer.from(b64, 'base64url').toString('utf8');
		const norm = b64.replaceAll('-', '+').replaceAll('_', '/');
		const bin = atob(norm);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	}
}
