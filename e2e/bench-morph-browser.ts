// ─────────────────────────────────────────────────────────────────────────────
// morph.ts GROUND-TRUTH bench — runs the compiled reconciler in real Chromium against a real DOM.
// The node bench (e2e/bench-morph.ts) is the fast proxy against a DOM shim; this is the honest
// number (live NodeList, native getAttribute, real attribute invalidation).
//
//   pnpm --filter ogygia build && node e2e/bench-morph-browser.ts "label"
//
// Bundles e2e/browser/morph-entry.js (imports the built dist morph) to an IIFE with rolldown,
// injects it into a blank page, and calls window.MorphBench.runBench().
// ─────────────────────────────────────────────────────────────────────────────
import { rolldown } from 'rolldown';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const label = process.argv[2] || 'unlabeled';

// 1. Bundle the in-page entry (+ dist morph) to a single IIFE exposing window.MorphBench.
const entry = path.join(repo, 'e2e/browser/morph-entry.js');
const bundle = await rolldown({ input: entry });
const { output } = await bundle.generate({ format: 'iife', name: '__MorphBenchBundle' });
await bundle.close();
const code = output[0].code;

// 2. Drive it in real Chromium.
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><html><head></head><body></body></html>');
await page.addScriptTag({ content: code });

console.log(`\n▸ morph bench — REAL CHROMIUM  [${label}]\n`);
const results = (await page.evaluate(() =>
	(window as any).MorphBench.runBench({ samples: 15 })
)) as {
	name: string;
	us: number;
	hz: number;
	iters: number;
}[];
await browser.close();

let total = 0;
for (const r of results) {
	total += r.us;
	console.log(
		`  ${r.name.padEnd(30)} ${r.us.toFixed(2).padStart(9)} µs/morph   (${Math.round(r.hz).toLocaleString()} morphs/s)`
	);
}
console.log(`  ${'Σ median'.padEnd(30)} ${total.toFixed(1).padStart(9)} µs\n`);
