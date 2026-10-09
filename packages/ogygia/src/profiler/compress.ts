/** a text answer at least this big goes out gzipped (see `gzip_large`) */
export const GZIP_OVER_BYTES = 256 * 1024;

/**
 * A big profiler answer (a report page is MBs of island props; the run page's `keep` answer carries
 * the whole report) gzipped when the browser takes it: AWS Lambda — Amplify's SSR — caps a response
 * at 6 MB before any CDN compresses it, and a heavy page's report crossed that and failed. Text only
 * (HTML, JSON), never a response that is already encoded, and never the profiler's own in-process
 * fetch (Kit hands that Response back as it is, and the standalone export reads it as text).
 */
export async function gzip_large(req: Request, res: Response): Promise<Response> {
	if (!res.body || res.headers.has('content-encoding') || req.headers.get('x-og-profiler-internal')) return res;
	if (!(req.headers.get('accept-encoding') ?? '').includes('gzip')) return res;
	const type = res.headers.get('content-type') ?? '';
	if (!type.startsWith('text/') && !type.includes('json')) return res;
	const known = Number(res.headers.get('content-length'));
	if (known && known < GZIP_OVER_BYTES) return res;
	const body = new Uint8Array(await res.arrayBuffer());
	const headers = new Headers(res.headers);
	if (body.byteLength < GZIP_OVER_BYTES) return new Response(body, { status: res.status, statusText: res.statusText, headers });
	const { gzip } = await import('node:zlib');
	const zipped = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) =>
		gzip(body, { level: 6 }, (err, out) => (err ? reject(err) : resolve(new Uint8Array(out.buffer as ArrayBuffer, out.byteOffset, out.byteLength))))
	);
	headers.set('content-encoding', 'gzip');
	headers.set('content-length', String(zipped.byteLength));
	headers.append('vary', 'accept-encoding');
	return new Response(zipped, { status: res.status, statusText: res.statusText, headers });
}
