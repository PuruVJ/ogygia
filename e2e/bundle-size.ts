#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia — runtime bundle-size measurement.
//
// Measures the client runtime cost per app profile the RIGHT way: an ISOLATED rolldown build of the
// feature-selected runtime entry (no app code, svelte externalized since Kit ships it anyway), so
// numbers are comparable across profiles instead of being scattered by per-app code-splitting.
//
// Reports brotli for each profile and the diff vs the committed baseline snapshot.
//
//   node e2e/bundle-size.ts            # measure + show diff vs snapshot
//   node e2e/bundle-size.ts --update   # rewrite the baseline snapshot
//   node e2e/bundle-size.ts --json     # machine-readable output (for the docs page)
// ─────────────────────────────────────────────────────────────────────────────
import { brotliCompressSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { generateRuntimeEntrySource, resolveFeatures } from '../packages/ogygia/dist/compiler/link/runtime-entry.js';
import type { RuntimeMarks } from '../packages/ogygia/dist/compiler/link/runtime-entry.js';

const RUNTIME_DIR = fileURLToPath(new URL('../packages/ogygia/dist/runtime', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./bundle-size.snapshot.json', import.meta.url));

const update = process.argv.includes('--update');
const asJson = process.argv.includes('--json');

// App profiles → the runtime marks a real app of that shape produces. `wire` + `remote-seeds` are
// always on (props/seeds decode); `forms` is on by default for progressively-enhanced actions.
const PROFILES: Array<{ name: string; blurb: string; marks: RuntimeMarks }> = [
	{ name: 'Static content', blurb: 'load-hydrated islands', marks: { complete: true, hydrate: ['load'], forms: false } },
	{ name: 'Interactive', blurb: 'interaction-hydrated widgets', marks: { complete: true, hydrate: ['interaction'], forms: false } },
	{ name: 'Forms', blurb: 'progressively-enhanced actions', marks: { complete: true, hydrate: ['load'], forms: true } },
	{ name: 'SPA router', blurb: 'client-side navigation', marks: { complete: true, hydrate: ['load'], router: true, forms: true } },
	{ name: 'Frozen regions', blurb: 'lakes', marks: { complete: true, hydrate: ['none'], lakes: true, forms: false } },
	{ name: 'Live regions', blurb: 'streaming held regions', marks: { complete: true, hydrate: ['load'], live: true, morph: true } },
	{
		name: 'Everything',
		blurb: 'kitchen sink',
		marks: {
			complete: true, hydrate: ['load', 'interaction', 'none'], defer: ['load'], router: true,
			live: true, morph: true, lakes: true, persist: true, persistKeys: ['x'], forms: true,
			wire: true, remoteSeeds: true
		}
	}
];

type Row = { name: string; blurb: string; features: string[]; raw: number; brotli: number };

async function measure(marks: RuntimeMarks): Promise<{ raw: number; brotli: number }> {
	const { code } = generateRuntimeEntrySource(marks, RUNTIME_DIR);
	const dir = mkdtempSync(join(tmpdir(), 'ogygia-size-'));
	const entry = join(dir, 'entry.mjs');
	writeFileSync(entry, code);
	// Bundle everything ogygia owns (core, features, devalue); externalize what the host app already
	// ships (svelte, Kit's $app, esm-env) so we measure ogygia's MARGINAL cost, not shared runtime.
	const bundle = await rolldown({
		input: entry,
		external: [/^svelte(\/|$)/, /^\$app\//, 'esm-env', /\.svelte$/],
		// Strip DEV like a real Vite prod build (import.meta.env.DEV → false), so the numbers reflect
		// what actually ships — not the dev-only warnings and the PropMutationGuard, which prod DCEs.
		transform: { define: { 'import.meta.env.DEV': 'false', 'import.meta.env.MODE': '"production"' } },
		logLevel: 'silent'
	});
	const { output } = await bundle.generate({ format: 'es', minify: true });
	await bundle.close();
	const js = output.filter((o: any) => o.type === 'chunk').map((o: any) => o.code).join('\n');
	const buf = Buffer.from(js);
	return { raw: buf.length, brotli: brotliCompressSync(buf).length };
}

const rows: Row[] = [];
for (const p of PROFILES) {
	const size = await measure(p.marks);
	rows.push({ name: p.name, blurb: p.blurb, features: resolveFeatures(p.marks), ...size });
}

if (update) {
	const snap = Object.fromEntries(rows.map((r) => [r.name, { raw: r.raw, brotli: r.brotli }]));
	writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + '\n');
	console.log(`✓ baseline snapshot written → e2e/bundle-size.snapshot.json`);
}

if (asJson) {
	console.log(JSON.stringify(rows, null, 2));
	process.exit(0);
}

const base: Record<string, { brotli: number }> = existsSync(SNAPSHOT)
	? JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
	: {};
const kb = (n: number) => (n / 1024).toFixed(2) + ' kB';
const delta = (cur: number, prev?: number) => {
	if (prev == null) return '—';
	const d = cur - prev;
	if (d === 0) return '±0';
	return (d > 0 ? '+' : '') + (d / 1024).toFixed(2) + ' kB';
};

console.log(`\nogygia runtime (brotli) — isolated rolldown build, svelte externalized\n`);
console.log('  ' + 'profile'.padEnd(16) + 'brotli'.padEnd(12) + 'Δ (vs baseline)');
console.log('  ' + '─'.repeat(48));
for (const r of rows) {
	console.log('  ' + r.name.padEnd(16) + kb(r.brotli).padEnd(12) + delta(r.brotli, base[r.name]?.brotli));
}
const avg = Math.round(rows.reduce((a, r) => a + r.brotli, 0) / rows.length);
console.log('  ' + '─'.repeat(48));
console.log('  ' + 'average'.padEnd(16) + kb(avg));
console.log('');
