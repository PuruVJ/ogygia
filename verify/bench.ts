// ─────────────────────────────────────────────────────────────────────────────
// ogygia perf bench — records checkpoints so every optimization is measured, not guessed.
//
//   node verify/bench.ts "baseline"          # micro-benches only (fast)
//   node verify/bench.ts "baseline" --build  # also cold-builds docs (adds ~4s)
//
// Appends a row to perf-checkpoints.md. Micro-benches isolate the PLUGIN transform cost from
// rollup/svelte; build timing captures the whole thing.
// ─────────────────────────────────────────────────────────────────────────────
import { transformHost } from '../packages/ogygia/dist/vite/transform.js';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const label = process.argv[2] || 'unlabeled';
const doBuild = process.argv.includes('--build');

const ctx = {
	root: '/app',
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
	wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
	devUrlFor: (p: string) => '/@id/' + p,
	visibleMargin: '0px',
	presets: {}
};
const HOST = '/app/src/routes/+page.svelte';

// ---- representative host sources ----
const wrap = (imports: string, markup: string) => `<script>\n${imports}\n</script>\n${markup}`;

// (A) island-heavy host: 6 imports across strategies + a couple usages each
const heavy = wrap(
	[
		`import A from '$lib/A.svelte' with { wake: 'load' };`,
		`import B from '$lib/B.svelte' with { wake: 'visible' };`,
		`import C from '$lib/C.svelte' with { wake: 'idle' };`,
		`import D from '$lib/D.svelte' with { wake: 'interaction' };`,
		`import E from '$lib/E.svelte' with { fill: 'load' };`,
		`import F from '$lib/F.svelte' with { fill: 'visible', wake: 'load' };`,
		`const items = [1,2,3];`
	].join('\n'),
	`<A n={1}/><A n={2}/><B/><C/><D/>{#each items as i}<E name={i}/>{/each}<F/>`
);

// (B) crossed-children host (the synth path)
const children = wrap(
	`import Card from '$lib/Card.svelte' with { wake: 'load' };\nconst who='Ada';`,
	`<Card title="x">{#snippet header()}<em>{who}</em>{/snippet}<p>hi {who}</p></Card>`
);

// (C) a plain host with NO island imports — the early-bail path (most files in a real app)
const plain = wrap(
	`import { onMount } from 'svelte';\nlet n = 0;`,
	`<h1>Hello</h1><p>{n}</p><button onclick={() => n++}>+</button>`
);

function bench(name: string, src: string, iters: number): number {
	// warm
	for (let i = 0; i < 200; i++) transformHost(src, HOST, ctx);
	const samples: number[] = [];
	for (let r = 0; r < 7; r++) {
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) transformHost(src, HOST, ctx);
		samples.push((performance.now() - t0) / iters);
	}
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)];
	console.log(`  ${name.padEnd(22)} ${(median * 1000).toFixed(1).padStart(7)} µs/call   (${Math.round(1 / median)} calls/ms)`);
	return median;
}

console.log(`\n▸ transformHost micro-bench  [${label}]`);
const mHeavy = bench('island-heavy (6+usages)', heavy, 3000);
const mChildren = bench('crossed-children', children, 3000);
const mPlain = bench('plain (no islands)', plain, 5000);

// ---- runtime chunk sizes ----
function runtimeChunk(appDir: string): { raw: number; gz: number } | null {
	const base = path.join(repo, appDir, '.svelte-kit/output/client/_app/immutable');
	if (!existsSync(base)) return null;
	const f = readdirSync(base).find((n) => /^ogygia-runtime\..*\.js$/.test(n));
	if (!f) return null;
	const buf = readFileSync(path.join(base, f));
	return { raw: buf.length, gz: gzipSync(buf).length };
}

// ---- optional cold build timing ----
let docsBuildMs: number | null = null;
if (doBuild) {
	console.log(`\n▸ cold docs build`);
	const docs = path.join(repo, 'docs');
	rmSync(path.join(docs, '.svelte-kit/output'), { recursive: true, force: true });
	rmSync(path.join(docs, 'node_modules/.vite'), { recursive: true, force: true });
	const t0 = performance.now();
	const res = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: docs, encoding: 'utf-8' });
	docsBuildMs = performance.now() - t0;
	if (res.status !== 0) {
		process.stderr.write(res.stderr ?? '');
		console.error('  build FAILED');
	} else {
		console.log(`  docs cold build: ${(docsBuildMs / 1000).toFixed(2)}s`);
	}
}

const docsRt = runtimeChunk('docs');
const pgRt = runtimeChunk('playground');
console.log(`\n▸ runtime chunk (gzip)`);
if (docsRt) console.log(`  docs        ${docsRt.gz} B gz  (${docsRt.raw} raw)`);
if (pgRt) console.log(`  playground  ${pgRt.gz} B gz  (${pgRt.raw} raw)`);

// ---- record checkpoint ----
const file = path.join(repo, 'perf-checkpoints.md');
if (!existsSync(file)) {
	writeFileSync(
		file,
		'# ogygia perf checkpoints\n\n' +
			'transformHost µs/call (lower better) · runtime chunk gzip B · docs cold build s. Recorded by `node verify/bench.ts <label>`.\n\n' +
			'| label | heavy µs | children µs | plain µs | docs rt gz | pg rt gz | docs build s |\n' +
			'| --- | --- | --- | --- | --- | --- | --- |\n'
	);
}
const row =
	`| ${label} ` +
	`| ${(mHeavy * 1000).toFixed(1)} ` +
	`| ${(mChildren * 1000).toFixed(1)} ` +
	`| ${(mPlain * 1000).toFixed(1)} ` +
	`| ${docsRt ? docsRt.gz : '-'} ` +
	`| ${pgRt ? pgRt.gz : '-'} ` +
	`| ${docsBuildMs ? (docsBuildMs / 1000).toFixed(2) : '-'} |\n`;
appendFileSync(file, row);
console.log(`\n✓ checkpoint '${label}' appended to perf-checkpoints.md\n`);
