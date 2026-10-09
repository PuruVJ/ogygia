// THE LCP LAB's hero image, answered in 2.6 s (a slow image server): a page that shows it at once has
// a largest paint of that long, most of it the download. A real picture's worth of bytes (random
// pixels, a PNG): Chrome leaves a low-entropy image (a big area in few bytes, like a flat SVG) out of
// the largest-paint candidates, and the plant would measure the heading instead.
import zlib from 'node:zlib';

const W = 600;
const H = 300;

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlib.crc32(body) >>> 0);
	return Buffer.concat([len, body, crc]);
}

let png: Buffer | null = null;
function hero(): Buffer {
	if (png) return png;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolor
	const raw = Buffer.alloc((W * 3 + 1) * H);
	let seed = 7;
	for (let i = 0; i < raw.length; i++) {
		if (i % (W * 3 + 1) === 0) continue; // the row's filter byte: none
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = seed & 0xff;
	}
	png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
	return png;
}

// (`?quick`: 300 ms — the late plant's image, so the late find, not the download, is its cost)
export const GET = async ({ url }) => {
	await new Promise((ok) => setTimeout(ok, url.searchParams.has('quick') ? 300 : 2600));
	return new Response(new Uint8Array(hero()), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
};
