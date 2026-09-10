#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia — runtime bundle-size measurement AND regression gate.
//
// Measures the client runtime cost per app profile the RIGHT way: an ISOLATED rolldown build of the
// feature-selected runtime entry (no app code, svelte externalized since Kit ships it anyway), so
// numbers are comparable across profiles instead of being scattered by per-app code-splitting.
//
// Two numbers per profile, both brotli:
//   • BOOT  — the entry chunk: what every page of that profile downloads to boot the runtime.
//   • TOTAL — the entry plus the lazy chunks (`hydrate-core` on the first island wake, `router-nav`
//             on the first prefetch/click, `interaction-replay` on the first arm): the most a page
//             can ever pull from the runtime.
// Either growing past the committed snapshot by more than 2 % FAILS the run (exit 1) — a size
// regression is a test failure, not a printed delta. Regenerate the snapshot on purpose, with
// `--update`, after a change that is meant to move the numbers.
//
//   node e2e/bundle-size.ts            # measure + gate against the snapshot
//   node e2e/bundle-size.ts --update   # rewrite the baseline snapshot
//   node e2e/bundle-size.ts --json     # machine-readable output (for the docs page)
// ─────────────────────────────────────────────────────────────────────────────
import { brotliCompressSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import {
	generateRuntimeEntrySource,
	resolveFeatures
} from '../packages/ogygia/dist/compiler/link/runtime-entry.js';
import type { RuntimeMarks } from '../packages/ogygia/dist/compiler/link/runtime-entry.js';

const RUNTIME_DIR = fileURLToPath(new URL('../packages/ogygia/dist/runtime', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./bundle-size.snapshot.json', import.meta.url));
/** A profile may grow this much over its snapshot before the gate fails. */
const TOLERANCE = 0.02;

const update = process.argv.includes('--update');
const asJson = process.argv.includes('--json');

// App profiles → the runtime marks a real app of that shape produces. `wire` + `remote-seeds` are
// always on (props/seeds decode); `forms` is on by default for progressively-enhanced actions.
const PROFILES: Array<{ name: string; blurb: string; marks: RuntimeMarks }> = [
	{
		name: 'Static content',
		blurb: 'load-hydrated islands',
		marks: { complete: true, hydrate: ['load'], forms: false }
	},
	{
		name: 'Interactive',
		blurb: 'interaction-hydrated widgets',
		marks: { complete: true, hydrate: ['interaction'], forms: false }
	},
	{
		name: 'Forms',
		blurb: 'progressively-enhanced actions',
		marks: { complete: true, hydrate: ['load'], forms: true }
	},
	{
		name: 'SPA router',
		blurb: 'client-side navigation',
		marks: { complete: true, hydrate: ['load'], router: true, forms: true }
	},
	{
		name: 'Frozen regions',
		blurb: 'lakes',
		marks: { complete: true, hydrate: ['none'], lakes: true, forms: false }
	},
	{
		name: 'Live regions',
		blurb: 'streaming held regions',
		marks: { complete: true, hydrate: ['load'], live: true, morph: true }
	},
	{
		name: 'Context',
		blurb: 'cross-island Provide / setContext',
		marks: { complete: true, hydrate: ['load'], context: true, forms: false }
	},
	{
		name: 'Everything',
		blurb: 'kitchen sink',
		marks: {
			complete: true,
			hydrate: ['load', 'interaction', 'none'],
			defer: ['load'],
			router: true,
			live: true,
			morph: true,
			lakes: true,
			persist: true,
			persistKeys: ['x'],
			forms: true,
			wire: true,
			remoteSeeds: true,
			context: true
		}
	}
];

type Size = { raw: number; brotli: number };
type Row = {
	name: string;
	blurb: string;
	features: string[];
	boot: Size;
	total: Size;
	lazy: Array<{ name: string } & Size>;
};
type Snapshot = Record<string, { boot: Size; total: Size }>;

const size = (code: string): Size => {
	const buf = Buffer.from(code);
	return { raw: buf.length, brotli: brotliCompressSync(buf).length };
};

async function measure(marks: RuntimeMarks): Promise<Pick<Row, 'boot' | 'total' | 'lazy'>> {
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
		// Mirror the plugin's `define` (vite/index.ts) at their prod defaults: the runtime's build-time
		// gates are `typeof __X__ !== 'undefined' ? __X__ : default`, which only fold when the toolchain
		// replaces the global. This isolated rolldown build bypasses the plugin, so define them here or
		// the devtools graph (and the server-delta branch) can't tree-shake — a false +4 kB per profile.
		transform: {
			define: {
				'import.meta.env.DEV': 'false',
				'import.meta.env.MODE': '"production"',
				__OGYGIA_DEVTOOLS__: 'false', // off by default — user apps never ship it
				__OGYGIA_CONTINUITY_FORMS__: 'true', // form continuity on by default (gated by the profile's marks)
				__OGYGIA_SERVER_DELTA__: 'false' // server-delta nav is opt-in
			}
		},
		logLevel: 'silent'
	});
	const { output } = await bundle.generate({ format: 'es', minify: true });
	await bundle.close();
	const chunks = output.filter((o: any) => o.type === 'chunk') as Array<{
		code: string;
		isEntry: boolean;
		fileName: string;
		imports: string[];
	}>;
	// BOOT is the entry chunk plus everything it imports STATICALLY (a module the entry shares with
	// a lazy chunk lands in a shared chunk the entry still loads at boot); the rest is lazy.
	const by_name = new Map(chunks.map((c) => [c.fileName, c]));
	const boot_set = new Set<string>();
	const walk = (name: string) => {
		if (boot_set.has(name)) return;
		boot_set.add(name);
		for (const dep of by_name.get(name)?.imports ?? []) walk(dep);
	};
	for (const c of chunks) if (c.isEntry) walk(c.fileName);
	const boot = size(chunks.filter((c) => boot_set.has(c.fileName)).map((c) => c.code).join('\n'));
	const total = size(chunks.map((c) => c.code).join('\n'));
	const lazy = chunks
		.filter((c) => !boot_set.has(c.fileName))
		.map((c) => ({ name: c.fileName.replace(/-[A-Za-z0-9_]+\.js$/, ''), ...size(c.code) }));
	return { boot, total, lazy };
}

const rows: Row[] = [];
for (const p of PROFILES) {
	const m = await measure(p.marks);
	rows.push({ name: p.name, blurb: p.blurb, features: resolveFeatures(p.marks), ...m });
}

if (update) {
	const snap: Snapshot = Object.fromEntries(rows.map((r) => [r.name, { boot: r.boot, total: r.total }]));
	writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + '\n');
	console.log(`✓ baseline snapshot written → e2e/bundle-size.snapshot.json`);
}

if (asJson) {
	console.log(JSON.stringify(rows, null, 2));
	process.exit(0);
}

const base: Snapshot = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : {};
/** A profile's baseline, or undefined when the snapshot predates the boot/total split. */
const baseline = (name: string) => (base[name]?.boot && base[name]?.total ? base[name] : undefined);
const kb = (n: number) => (n / 1024).toFixed(2) + ' kB';
const delta = (cur: number, prev?: number) => {
	if (prev == null) return '—';
	const d = cur - prev;
	if (d === 0) return '±0';
	return (d > 0 ? '+' : '') + (d / 1024).toFixed(2) + ' kB';
};

console.log(`\nogygia runtime (brotli) — isolated rolldown build, svelte externalized\n`);
console.log(
	'  ' + 'profile'.padEnd(16) + 'boot'.padEnd(11) + 'Δ'.padEnd(11) + 'total'.padEnd(11) + 'Δ'.padEnd(11) + 'lazy chunks'
);
console.log('  ' + '─'.repeat(84));
const failures: string[] = [];
for (const r of rows) {
	const prev = baseline(r.name);
	console.log(
		'  ' +
			r.name.padEnd(16) +
			kb(r.boot.brotli).padEnd(11) +
			delta(r.boot.brotli, prev?.boot.brotli).padEnd(11) +
			kb(r.total.brotli).padEnd(11) +
			delta(r.total.brotli, prev?.total.brotli).padEnd(11) +
			r.lazy.map((l) => `${l.name} ${kb(l.brotli)}`).join(', ')
	);
	if (!prev || update) continue;
	for (const key of ['boot', 'total'] as const) {
		const limit = Math.ceil(prev[key].brotli * (1 + TOLERANCE));
		if (r[key].brotli > limit)
			failures.push(
				`${r.name} ${key}: ${kb(r[key].brotli)} > ${kb(limit)} (snapshot ${kb(prev[key].brotli)} + ${TOLERANCE * 100} %)`
			);
	}
}
const avg = Math.round(rows.reduce((a, r) => a + r.boot.brotli, 0) / rows.length);
console.log('  ' + '─'.repeat(84));
console.log('  ' + 'average boot'.padEnd(16) + kb(avg));
console.log('');
if (failures.length) {
	console.error('✗ bundle-size regression (over snapshot + 2 %):\n  ' + failures.join('\n  '));
	console.error('  If the growth is intended, refresh the baseline: node e2e/bundle-size.ts --update');
	process.exit(1);
}
