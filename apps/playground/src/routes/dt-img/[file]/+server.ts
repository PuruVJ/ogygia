// The image lab's files, made here as PNGs (no image files in the repo): `big.png` 2000×1333 with
// every 25th row noise (~340 KB), `flat.png` the same size in one colour (~11 KB), `right.png`
// 400×300 all noise (~350 KB). What the devtools read is each file's pixels against the box it shows in.
import { randomFillSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const crc_table = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc = (b: Uint8Array) => {
	let c = 0xffffffff;
	for (const x of b) c = crc_table[(c ^ x) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
	return out;
};

/** an RGB PNG; every `noisy`-th row random, the rest one colour (`noisy` 0: all one colour) */
function png(w: number, h: number, noisy: number): Uint8Array {
	const raw = new Uint8Array((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		const row = raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
		if (noisy && y % noisy === 0) randomFillSync(row);
		else row.fill(200);
	}
	const head = new Uint8Array(13);
	const view = new DataView(head.buffer);
	view.setUint32(0, w);
	view.setUint32(4, h);
	head.set([8, 2, 0, 0, 0], 8);
	const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const made = new Map<string, Uint8Array>();
const SPEC: Record<string, [number, number, number]> = { 'big.png': [2000, 1333, 25], 'flat.png': [2000, 1333, 0], 'right.png': [400, 300, 1] };

export const GET = ({ params }) => {
	const spec = SPEC[params.file];
	if (!spec) return new Response('no such image', { status: 404 });
	let bytes = made.get(params.file);
	if (!bytes) made.set(params.file, (bytes = png(...spec)));
	return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
};
