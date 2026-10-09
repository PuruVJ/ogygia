import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { GZIP_OVER_BYTES, gzip_large } from '../src/profiler/compress.js';

// A big profiler answer goes out gzipped (AWS Lambda caps a response at 6 MB before any CDN
// compresses it); small ones, binary ones, already-encoded ones and the profiler's own in-process
// fetch go out as they are.
const big = 'x'.repeat(GZIP_OVER_BYTES + 10);
const req = (h: Record<string, string> = {}) => new Request('http://x/__profiler/report/a', { headers: { 'accept-encoding': 'gzip, br', ...h } });
const res = (body: string, type = 'text/html; charset=utf-8', h: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': type, ...h } });

describe('gzip_large', () => {
	it('gzips a big HTML or JSON answer the browser takes gzip for', async () => {
		const out = await gzip_large(req(), res(big));
		expect(out.headers.get('content-encoding')).toBe('gzip');
		const bytes = Buffer.from(await out.arrayBuffer());
		expect(Number(out.headers.get('content-length'))).toBe(bytes.byteLength);
		expect(bytes.byteLength).toBeLessThan(big.length / 10);
		expect(gunzipSync(bytes).toString()).toBe(big);
		expect((await gzip_large(req(), res(big, 'application/json'))).headers.get('content-encoding')).toBe('gzip');
	});

	it('leaves the rest alone', async () => {
		// small
		const small = await gzip_large(req(), res('hi'));
		expect(small.headers.get('content-encoding')).toBeNull();
		expect(await small.text()).toBe('hi');
		// no gzip asked for
		expect((await gzip_large(new Request('http://x/'), res(big))).headers.get('content-encoding')).toBeNull();
		// binary (the .ogp download)
		expect((await gzip_large(req(), res(big, 'application/octet-stream'))).headers.get('content-encoding')).toBeNull();
		// already encoded
		expect((await gzip_large(req(), res(big, 'text/html', { 'content-encoding': 'br' }))).headers.get('content-encoding')).toBe('br');
		// the profiler's own in-process fetch reads the body as text
		expect((await gzip_large(req({ 'x-og-profiler-internal': '1' }), res(big))).headers.get('content-encoding')).toBeNull();
	});
});
