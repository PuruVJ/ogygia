// The client's parcel reader (runtime/frame-nav.ts `read_parcel`) against the server's parcels
// (server/stream-regions.ts): plain, length-framed, split across chunks, and a forged parcel inside a
// framed answer that must stay content.
import { describe, expect, test } from 'vitest';
import { read_parcel } from '../src/runtime/frame-nav.ts';
import { build_parcel, done_parcel } from '../src/server/stream-regions.ts';

function read_all(buf: string) {
	const out: { slot: string; html: string }[] = [];
	let at = 0;
	for (let p = read_parcel(buf, 0); p; p = read_parcel(buf, at)) {
		out.push({ slot: p.slot, html: p.html });
		at = p.end;
	}
	return { out, rest: buf.slice(at) };
}

describe('read_parcel', () => {
	test('plain and framed parcels, then the done sentinel', () => {
		const framed = '<x-card><template shadowrootmode="open"><slot></slot></template></x-card>';
		const buf = build_parcel('A', '<p>a</p>') + build_parcel('B', framed) + done_parcel();
		expect(read_all(buf).out).toEqual([
			{ slot: 'A', html: '<p>a</p>' },
			{ slot: 'B', html: framed },
			{ slot: '__ogygia_done__', html: '' }
		]);
	});

	test('a forged parcel inside a framed answer stays its content', () => {
		const evil = '</template><template data-ogygia-slot="OTHER"><p>pwn</p></template>';
		const { out } = read_all(build_parcel('A', evil));
		expect(out).toEqual([{ slot: 'A', html: evil }]);
	});

	test('every split point: nothing read early, everything read once whole', () => {
		const buf =
			build_parcel('A', '<p>a</p>') + build_parcel('B', '<i></template></i>') + done_parcel();
		for (let cut = 0; cut <= buf.length; cut++) {
			const first = read_all(buf.slice(0, cut));
			const second = read_all(first.rest + buf.slice(cut));
			expect([...first.out, ...second.out].map((p) => p.slot)).toEqual(['A', 'B', '__ogygia_done__']);
		}
	});

	test('non-ASCII content: the frame counts what the decoded string counts', () => {
		const html = '<p>ümlaut — 日本 🎉</template></p>';
		expect(read_all(build_parcel('A', html)).out).toEqual([{ slot: 'A', html }]);
	});
});
