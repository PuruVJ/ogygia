// Out-of-order streaming PROOF. Usage: node verify/frame-ooo.ts [baseUrl]
//
// /ooo has three deferred regions with staggered server delays, declared A(300) → B(50) → C(150).
// POST them to the batch endpoint and read the streamed <template data-ogygia-slot> frames IN ARRIVAL
// ORDER. They must arrive fast-first — B, C, A — NOT in declaration order. That is out-of-order: the
// server flushes each frame the moment its region settles.
const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const unentity = (s: string) => s.replace(/&amp;/g, '&').replace(/&#38;/g, '&');

const html = await (await fetch(base + '/ooo')).text();
// endpoint → its ms (from the region's fallback sibling; simpler: decode the props in order of the DOM).
const regions = [...html.matchAll(/<ogygia-region\b[^>]*\bendpoint="([^"]+)"/g)].map((m) => unentity(m[1]));
check('page exposes 3 deferred regions', regions.length === 3, `${regions.length}`);
if (regions.length !== 3) { console.log(out.join('\n')); process.exit(1); }

// sig → seconds: fetch each region once (GET) to read its "settled after Nms" text, so we can label frames.
const sigOf = (e: string) => new URLSearchParams(e.slice(e.indexOf('?') + 1)).get('sig') || '';
const path = '/' + (regions[0].slice(0, regions[0].indexOf('?'))).replace(/^[./]+/, '');
const sigMs = new Map<string, number>();
for (const e of regions) {
	const p = '/' + e.replace(/^[./]+/, '');
	const body = await (await fetch(base + p)).text();
	const ms = Number(body.match(/settled after (\d+)s/)?.[1] ?? -1);
	sigMs.set(sigOf(e), ms);
}
check('labelled all three by delay', [...sigMs.values()].sort((a, b) => a - b).join(",") === "1,2,3", [...sigMs.values()].join(','));

// Now POST the batch and read frame ARRIVAL order.
const res = await fetch(base + path, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(regions)
});
const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = '';
const arrivalMs: number[] = [];
const RE = /<template data-ogygia-slot="([^"]*)">/g;
for (;;) {
	const { done, value } = await reader.read();
	if (done) break;
	buf += dec.decode(value, { stream: true });
	let m: RegExpExecArray | null;
	RE.lastIndex = 0;
	let consumed = 0;
	while ((m = RE.exec(buf))) {
		consumed = m.index + m[0].length;
		const slot = m[1];
		if (slot === '__ogygia_done__') continue;
		if (sigMs.has(slot)) arrivalMs.push(sigMs.get(slot)!);
	}
	if (consumed) buf = buf.slice(consumed);
}

check('all three frames arrived', arrivalMs.length === 3, arrivalMs.join(' → ') + 'ms');
// Settle order = ascending delay. Declaration order was 300, 50, 150.
check('OUT-OF-ORDER: frames arrived fast-first (1s → 2s → 3s), NOT declaration order (3, 1, 2)',
	arrivalMs.join(",") === "1,2,3",
	'arrival: ' + arrivalMs.join(' → ') + 'ms');

console.log(out.join('\n'));
process.exit(failures);

export {};
