/**
 * Ask the server for a report's representation (`html`, `json`, `dump`) in a way that works on a
 * serverless host, where the instance that made the report is rarely the one a later request lands
 * on. The report rides WITH the request: the page's own `.ogp` bytes when it has them (compressed
 * and encrypted: small, and only the server's key opens them), else this browser's kept copy
 * (IndexedDB), gzipped. Request bodies are capped (512 KB by default on adapter-node), so a report
 * is never sent as raw JSON. With neither, a plain GET by id (a server that still holds it).
 */
import { get_report } from './store.js';

/** the element the report page carries its `.ogp` bytes in, ONCE (base64): every button reads it
 *  here at click time instead of taking a copy as a prop (five buttons held 1.2 MB of copies) */
export const OGP_ELEMENT_ID = 'og-report-ogp';

/** the page's `.ogp` bytes as base64, or '' (a report shown from this browser's kept copy) */
export function page_ogp(): string {
	return typeof document === 'undefined' ? '' : (document.getElementById(OGP_ELEMENT_ID)?.textContent ?? '').trim();
}

async function carried(id: string, ogpB64: string): Promise<{ body: BodyInit; headers: Record<string, string> } | null> {
	ogpB64 ||= page_ogp();
	if (ogpB64) {
		const bin = atob(ogpB64);
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		return { body: arr, headers: { 'content-type': 'application/octet-stream' } };
	}
	const kept = await get_report(id);
	if (!kept || typeof CompressionStream === 'undefined') return null;
	const gz = new Blob([JSON.stringify(kept.dump)]).stream().pipeThrough(new CompressionStream('gzip'));
	return { body: await new Response(gz).blob(), headers: { 'content-type': 'application/json', 'x-og-encoding': 'gzip' } };
}

export async function report_request(base: string, id: string, as: 'html' | 'json' | 'dump' | 'ogp', ogpB64 = ''): Promise<Response> {
	const url = `${base}/report/${id}.${as}`;
	const c = await carried(id, ogpB64);
	return c ? fetch(url, { method: 'POST', headers: c.headers, body: c.body, credentials: 'same-origin' }) : fetch(url, { credentials: 'same-origin' });
}
