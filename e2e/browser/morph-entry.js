// In-page entry for the real-Chromium morph bench. Bundled to an IIFE by verify/bench-morph-browser.ts
// and injected into a blank page, where it runs the SAME scenarios as the node/shim bench but against
// a real DOM (real childNodes NodeList, real getAttribute, real attribute invalidation). This is the
// ground truth — the node bench is the fast proxy.
import { morph_children } from '../../packages/ogygia/dist/runtime/morph.js';

let seed = 0x1234abcd;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function keyedList(n, gen) {
	let s = '<ul>';
	for (let i = 0; i < n; i++) s += `<li id="row-${i}" class="r${gen & 1}">Item ${i} · v${gen}</li>`;
	return s + '</ul>';
}
function shuffledList(n, gen) {
	const order = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	let s = '<ul>';
	for (const i of order) s += `<li id="row-${i}" class="r${gen & 1}">Item ${i} · v${gen}</li>`;
	return s + '</ul>';
}
function positionalList(n, gen) {
	let s = '<div>';
	for (let i = 0; i < n; i++) s += `<p>line ${i} gen ${gen}</p>`;
	return s + '</div>';
}
// Structured reorder where LIS shines: a rotate keeps one long in-order run, so only O(1) nodes move.
// Row CONTENT is stable across gens (a pure reorder, e.g. drag/sort) so the bench isolates move cost
// from per-row content morphing — the exact work LIS reduces.
function rotatedList(n, gen) {
	const shift = 1 + (gen % 3);
	let s = '<ul>';
	for (let i = 0; i < n; i++) {
		const k = (i + shift) % n;
		s += `<li id="row-${k}">Item ${k}</li>`;
	}
	return s + '</ul>';
}
// A handful of items yanked to the front — the common "pin / move a few" edit. Stable content.
function moveFewList(n, gen) {
	const order = Array.from({ length: n }, (_, i) => i);
	for (let m = 0; m < 4; m++) {
		const from = (gen * 7 + m * 131) % n;
		order.splice(from, 1);
		order.unshift(from);
	}
	let s = '<ul>';
	for (const i of order) s += `<li id="row-${i}">Item ${i}</li>`;
	return s + '</ul>';
}
function table(rows, cols, gen) {
	let s = '<table><tbody>';
	for (let r = 0; r < rows; r++) {
		s += `<tr id="tr-${r}">`;
		for (let c = 0; c < cols; c++) s += `<td class="c${(gen + c) & 3}">${r},${c}:${gen}</td>`;
		s += '</tr>';
	}
	return s + '</tbody></table>';
}
function deepTree(sections, cardsPer, gen) {
	let s = '<main>';
	for (let a = 0; a < sections; a++) {
		s += `<section id="s-${a}"><header class="g${gen & 1}"><h2>Section ${a}</h2></header>`;
		for (let b = 0; b < cardsPer; b++) {
			s += `<article id="c-${a}-${b}" class="card v${gen & 3}"><h3>Card ${b}</h3><p>body ${a}/${b} rev ${gen}</p><footer><span>meta ${gen}</span></footer></article>`;
		}
		s += '</section>';
	}
	return s + '</main>';
}
function attrChurn(n, gen) {
	let s = '<div>';
	for (let i = 0; i < n; i++) {
		s += `<span id="a-${i}" class="x${gen & 3}" data-a="${gen}" data-b="${i}" data-c="${(gen + i) & 7}" title="t${gen}" role="cell" aria-label="l${gen}">x</span>`;
	}
	return s + '</div>';
}

/** Parse an HTML string into a detached array of real DOM child nodes of its single root. */
function parseRootChildren(html) {
	const tpl = document.createElement('template');
	tpl.innerHTML = html;
	const root = tpl.content.firstElementChild;
	return Array.from(root.childNodes);
}
/** Parse an HTML string into a live root element attached under a host. */
function liveRoot(host, html) {
	const tpl = document.createElement('template');
	tpl.innerHTML = html;
	const root = tpl.content.firstElementChild;
	host.replaceChildren(root);
	return root;
}

const SCENARIOS = [
	{ name: 'keyed list ·200 (breathe)', build: (g) => keyedList(200, g) },
	{ name: 'keyed list ·2000 (breathe)', build: (g) => keyedList(2000, g) },
	{ name: 'keyed reorder ·200', build: (g) => shuffledList(200, g) },
	{ name: 'keyed reorder ·2000', build: (g) => shuffledList(2000, g) },
	{ name: 'keyed rotate ·2000', build: (g) => rotatedList(2000, g) },
	{ name: 'keyed move-few ·2000', build: (g) => moveFewList(2000, g) },
	{ name: 'positional ·500', build: (g) => positionalList(500, g) },
	{ name: 'table 100×10', build: (g) => table(100, 10, g) },
	{ name: 'table 500×15 (hi-vol)', build: (g) => table(500, 15, g) },
	{ name: 'deep tree 40×8', build: (g) => deepTree(40, 8, g) },
	{ name: 'attr churn ·400', build: (g) => attrChurn(400, g) }
];

/**
 * Median-of-samples timing per scenario. Each sample runs `iters` morphs toward round-robin target
 * states; we auto-size `iters` so a sample is ~8ms (stable vs. rAF/GC jitter) and take the median of
 * `samples`. Returns µs/morph + morphs/s.
 */
export function runBench(cfg = {}) {
	const samples = cfg.samples ?? 15;
	const host = document.createElement('div');
	document.body.appendChild(host);
	const out = [];

	for (const sc of SCENARIOS) {
		const targets = [1, 2, 3, 4].map((g) => parseRootChildren(sc.build(g)));
		const parent = liveRoot(host, sc.build(0));

		// warm + auto-size iters to ~8ms/sample
		let iters = 8;
		for (;;) {
			const t0 = performance.now();
			for (let i = 0; i < iters; i++) morph_children(parent, targets[i & 3]);
			const dt = performance.now() - t0;
			if (dt >= 8 || iters >= 100000) break;
			iters = Math.max(iters + 1, Math.ceil((iters * 9) / Math.max(dt, 0.05)));
		}

		const times = [];
		for (let s = 0; s < samples; s++) {
			const t0 = performance.now();
			for (let i = 0; i < iters; i++) morph_children(parent, targets[i & 3]);
			times.push((performance.now() - t0) / iters);
		}
		times.sort((a, b) => a - b);
		const us = times[times.length >> 1] * 1000;
		out.push({ name: sc.name, us, hz: 1e6 / us, iters });
	}

	host.remove();
	return out;
}

globalThis.MorphBench = { runBench };
