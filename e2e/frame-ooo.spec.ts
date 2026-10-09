// Out-of-order streaming PROOF. Usage: pnpm exec playwright test frame-ooo
//
// /ooo has three deferred regions with staggered server delays, declared A(300) → B(50) → C(150).
// POST them to the batch endpoint and read the streamed <template data-ogygia-slot> frames IN ARRIVAL
// ORDER. They must arrive fast-first — B, C, A — NOT in declaration order. That is out-of-order: the
// server flushes each frame the moment its region settles.
import { test, check } from './fixtures/index.ts';
import {
	AMP_ENTITY_G_RE,
	AMP_NUMERIC_G_RE,
	LEADING_DOTS_RE,
	REGION_ENDPOINT_G_RE
} from './fixtures/re.ts';

const SETTLED_AFTER_RE = /settled after (\d+)s/;
const SLOT_RE = /<template data-ogygia-slot="([^"]*)">/g;

const unentity = (s: string) => s.replace(AMP_ENTITY_G_RE, '&').replace(AMP_NUMERIC_G_RE, '&');

test.describe('out-of-order streaming: staggered regions flush fast-first, not declaration order', () => {
	test('frames arrive fast-first (1s → 2s → 3s), not in declaration order (3, 1, 2)', async ({
		baseURL
	}) => {
		const html = await (await fetch(baseURL + '/ooo')).text();
		// endpoint → its ms (from the region's fallback sibling; simpler: decode the props in order of the DOM).
		const regions = [...html.matchAll(REGION_ENDPOINT_G_RE)].map((m) => unentity(m[1]));
		check('page exposes 3 deferred regions', regions.length === 3, `${regions.length}`);
		// The script bailed here; the soft check above already recorded the failure.
		if (regions.length !== 3) return;

		// sig → seconds: fetch each region once (GET) to read its "settled after Nms" text, so we can label frames.
		const sig_of = (e: string) => new URLSearchParams(e.slice(e.indexOf('?') + 1)).get('sig') || '';
		const path = '/' + regions[0].slice(0, regions[0].indexOf('?')).replace(LEADING_DOTS_RE, '');
		const sig_ms = new Map<string, number>();
		for (const e of regions) {
			const p = '/' + e.replace(LEADING_DOTS_RE, '');
			const body = await (await fetch(baseURL + p)).text();
			const ms = Number(body.match(SETTLED_AFTER_RE)?.[1] ?? -1);
			sig_ms.set(sig_of(e), ms);
		}
		check(
			'labelled all three by delay',
			[...sig_ms.values()].sort((a, b) => a - b).join(',') === '1,2,3',
			[...sig_ms.values()].join(',')
		);

		// Now POST the batch and read frame ARRIVAL order.
		const res = await fetch(baseURL + path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(regions)
		});
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = '';
		const arrival_ms: number[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let m: RegExpExecArray | null;
			SLOT_RE.lastIndex = 0;
			let consumed = 0;
			while ((m = SLOT_RE.exec(buf))) {
				consumed = m.index + m[0].length;
				const slot = m[1];
				if (slot === '__ogygia_done__') continue;
				if (sig_ms.has(slot)) arrival_ms.push(sig_ms.get(slot)!);
			}
			if (consumed) buf = buf.slice(consumed);
		}

		check('all three frames arrived', arrival_ms.length === 3, arrival_ms.join(' → ') + 'ms');
		// Settle order = ascending delay. Declaration order was 300, 50, 150.
		check(
			'OUT-OF-ORDER: frames arrived fast-first (1s → 2s → 3s), NOT declaration order (3, 1, 2)',
			arrival_ms.join(',') === '1,2,3',
			'arrival: ' + arrival_ms.join(' → ') + 'ms'
		);
	});
});
