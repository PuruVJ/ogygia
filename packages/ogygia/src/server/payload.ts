// URL-safe base64 for the (devalue-stringified) server-island props payload.
// Portable across server (node) and any client bundling: uses TextEncoder/TextDecoder +
// btoa/atob, all available in node 18+ and browsers.

export class B64Url {
	/** @param str utf-8 string */
	static encode(str: string): string {
		const bytes = new TextEncoder().encode(str);
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
	}

	/** @param b64 base64url string */
	static decode(b64: string): string {
		const norm = b64.replaceAll('-', '+').replaceAll('_', '/');
		const bin = atob(norm);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	}
}
