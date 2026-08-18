#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia CORE ops/sec microbenchmark. Bundles the per-island / per-nav hot functions
// (region-attrs, region-endpoint-url, frame) into a browser IIFE with rolldown, runs each in real
// Chromium under a fixed time budget, and reports operations/second. Deterministic, no server.
//
//   node internal/bench/router/ops.ts
//
// Output → internal/bench/results/ops-latest.{md,json}. Re-run after an optimization to see the gain.
// ─────────────────────────────────────────────────────────────────────────────
import { rolldown } from 'rolldown';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const entry = join(repo, 'internal/bench/router/ops-cases.ts');

// devalue lives in the pnpm store (symlinked into packages/ogygia/node_modules), not repo-root
// node_modules, so rolldown can't resolve the bare specifier from the bench dir — alias it.
function resolveDevalue(): string {
	const store = join(repo, 'node_modules/.pnpm');
	const hit = existsSync(store) ? readdirSync(store).find((d) => d.startsWith('devalue@')) : null;
	if (hit) return join(store, hit, 'node_modules/devalue/index.js');
	return join(repo, 'packages/ogygia/node_modules/devalue/index.js');
}
const BUDGET_MS = 400; // per-case measured window
const ROUNDS = 5; // best-of, to shed GC/JIT noise

// ── bundle the cases (+ their real source deps) to a browser IIFE ────────────
const bundle = await rolldown({
	input: entry,
	platform: 'browser',
	logLevel: 'silent',
	resolve: { alias: { devalue: resolveDevalue() } }
});
const { output } = await bundle.generate({ format: 'iife', name: 'OpsBench' });
const code = output[0].code;

// ── run in Chromium ──────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: code });

const names: string[] = await page.evaluate(() => Object.keys((window as any).__opscases));

// Warm each case (JIT), then measure best-of-ROUNDS ops/sec over a fixed time budget.
const results: Array<{ name: string; opsPerSec: number; nsPerOp: number }> = [];
for (const name of names) {
	const best = await page.evaluate(
		({ name, budget, rounds }) => {
			const fn = (window as any).__opscases[name] as () => unknown;
			// warm
			for (let i = 0; i < 10000; i++) fn();
			let bestOps = 0;
			for (let r = 0; r < rounds; r++) {
				let ops = 0;
				const t0 = performance.now();
				// batch to amortize the clock read
				while (performance.now() - t0 < budget) {
					for (let i = 0; i < 2000; i++) fn();
					ops += 2000;
				}
				const elapsed = performance.now() - t0;
				const ps = (ops / elapsed) * 1000;
				if (ps > bestOps) bestOps = ps;
			}
			return bestOps;
		},
		{ name, budget: BUDGET_MS, rounds: ROUNDS }
	);
	results.push({ name, opsPerSec: best, nsPerOp: 1e9 / best });
}

await browser.close();

// ── report ───────────────────────────────────────────────────────────────────
results.sort((a, b) => a.opsPerSec - b.opsPerSec); // slowest (hottest to fix) first
const fmtOps = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n / 1e3).toFixed(0) + 'k');
const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).stdout?.trim();

console.log('\n\x1b[1m\x1b[36mCORE OPS/SEC — slowest first (best-of-' + ROUNDS + ', ' + BUDGET_MS + 'ms window)\x1b[0m');
const lines: string[] = [];
for (const r of results) {
	const line = `${r.name.padEnd(26)} ${fmtOps(r.opsPerSec).padStart(7)} ops/s   ${r.nsPerOp.toFixed(1).padStart(7)} ns/op`;
	lines.push(line);
	console.log('  ' + line);
}

const md = [
	'# ogygia core ops/sec',
	'',
	`Per-island / per-nav hot functions, bundled from source and run in real Chromium. ${new Date().toISOString()}, commit \`${commit}\`. Best-of-${ROUNDS} over a ${BUDGET_MS}ms window each. Sorted slowest-first (the hottest to optimize).`,
	'',
	'```',
	...lines,
	'```',
	''
].join('\n');

const outDir = join(repo, 'internal/bench/results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'ops-latest.md'), md);
writeFileSync(join(outDir, 'ops-latest.json'), JSON.stringify({ commit, date: new Date().toISOString(), budgetMs: BUDGET_MS, rounds: ROUNDS, results }, null, '\t'));
console.log(`\n  results → internal/bench/results/ops-latest.md (+ .json)`);
