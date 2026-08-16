#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia COMPILER / vite-transform STRESS BENCHMARK.
//
// Hammers the real build repeatedly and watches the transform layer for three things:
//   1. THROUGHPUT — per-phase ogygia time (transformMs / prescanMs / bakeMs) via the OGYGIA_PROFILE
//      instrument, across N builds → p50/p90/max + variance. Drift or high variance = a problem.
//   2. DETERMINISM — hash the emitted client JS across builds. The compiler MUST be byte-deterministic
//      (same source → same output) or caching, reproducible builds, and CI diffs all break.
//   3. CACHE — transform_cache hit ratio (transformHit / (transformN+transformHit)).
//
//   node internal/bench/compiler-stress.ts [--app playground|docs] [--n 5]
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const app = (argv.find((a) => a.startsWith('--app='))?.slice(6)) || 'playground';
const N = Number(argv.find((a) => a.startsWith('--n='))?.slice(4) || 5);
const appDir = join(repo, 'apps', app);
const vite = join(appDir, 'node_modules/vite/bin/vite.js');
const clientOut = join(appDir, '.svelte-kit/output/client/_app/immutable');

type Prof = { transformMs: number; transformN: number; transformHit: number; prescanMs: number; bakeMs: number; bakeN: number; transformDigest?: string; transformFiles?: number };
const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
	return { p50: q(0.5), p90: q(0.9), min: s[0], max: s[s.length - 1], sd };
};
const f1 = (n: number) => n.toFixed(1);

// hash every emitted client JS chunk (sorted) — the compiler's observable output
function outputHash(): string {
	if (!existsSync(clientOut)) return 'NO-OUTPUT';
	const files: string[] = [];
	const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
	walk(clientOut);
	files.sort();
	// Hash CONTENT ONLY, filename-independent: Vite's chunk filenames are content-hashes derived from
	// the un-normalized bytes, so they cascade from any change and can't be part of a determinism check.
	// Normalize SvelteKit's two per-build artifacts (module-scope nonce + `version.name` = Date.now())
	// so what remains is purely OGYGIA's compiler output. Sort by normalized content → order-independent.
	const normKit = (c: string) =>
		c.replace(/__sveltekit_[a-z0-9]+/g, '__sveltekit_NONCE').replace(/\b17\d{11}\b/g, 'KIT_VERSION_TS');
	const contents = files.map((f) => normKit(readFileSync(f, 'utf8'))).sort();
	const h = createHash('sha256');
	for (const c of contents) h.update(c);
	return h.digest('hex').slice(0, 16);
}

const runs: Array<{ ssr: Prof; client: Prof; wallMs: number; hash: string }> = [];
console.log(`\x1b[1m\x1b[36m▸ compiler stress — ${app}, ${N} clean builds\x1b[0m`);
for (let i = 0; i < N; i++) {
	rmSync(join(appDir, '.svelte-kit/output'), { recursive: true, force: true });
	const t0 = Date.now();
	const res = spawnSync(process.execPath, [vite, 'build'], { cwd: appDir, encoding: 'utf-8', maxBuffer: 128*1024*1024, env: { ...process.env, OGYGIA_PROFILE: '1' } });
	const wallMs = Date.now() - t0;
	const profs = [...(res.stderr || '').matchAll(/\[ogygia-prof\] (\{.*\})/g)].map((m) => JSON.parse(m[1]) as Prof);
	if (res.error) { console.error(`  build ${i} spawn error:`, res.error.message); process.exit(1); }
	if (profs.length < 2) { console.error(`  build ${i} produced ${profs.length} prof lines (status ${res.status}) — FAIL\n${(res.stderr||'').slice(-800)}`); process.exit(1); }
	// The compiler-determinism signal is OGYGIA's transform digest (per-file output, order-independent),
	// NOT the final bundle hash — Vite 8/rolldown chunk-splitting is itself non-deterministic (a plain
	// SvelteKit app fails the bundle check too), so the bundle hash measures the bundler, not us.
	const hash = `${profs[0].transformDigest}·${profs[1].transformDigest}`;
	runs.push({ ssr: profs[0], client: profs[1], wallMs, hash });
	process.stdout.write(`  build ${i + 1}/${N}: wall ${wallMs}ms  ogygia ${f1(profs[0].transformMs + profs[1].transformMs + profs[0].prescanMs + profs[1].prescanMs)}ms  out#${hash}\n`);
}

const ogygiaTotal = runs.map((r) => r.ssr.transformMs + r.client.transformMs + r.ssr.prescanMs + r.client.prescanMs);
const transformOnly = runs.map((r) => r.ssr.transformMs + r.client.transformMs);
const prescanOnly = runs.map((r) => r.ssr.prescanMs + r.client.prescanMs);
const wall = runs.map((r) => r.wallMs);
const hashes = new Set(runs.map((r) => r.hash));
const hitRatio = (r: Prof) => r.transformHit / (r.transformN + r.transformHit);

const st = stats(ogygiaTotal), stt = stats(transformOnly), stp = stats(prescanOnly), sw = stats(wall);
console.log(`\n  wall            p50 ${f1(sw.p50)}ms  p90 ${f1(sw.p90)}  sd ${f1(sw.sd)}`);
console.log(`  ogygia total    p50 ${f1(st.p50)}ms  p90 ${f1(st.p90)}  min ${f1(st.min)}  max ${f1(st.max)}  sd ${f1(st.sd)}`);
console.log(`    transform     p50 ${f1(stt.p50)}ms  (sd ${f1(stt.sd)})`);
console.log(`    prescan       p50 ${f1(stp.p50)}ms  (sd ${f1(stp.sd)})`);
console.log(`  cache hit ratio ssr ${(hitRatio(runs[0].ssr) * 100).toFixed(0)}%  client ${(hitRatio(runs[0].client) * 100).toFixed(0)}%`);
console.log(`  ogygia % of wall ${((st.p50 / sw.p50) * 100).toFixed(1)}%`);
const detOk = hashes.size === 1;
console.log(`\n  \x1b[1mCOMPILER DETERMINISM: ${detOk ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m — ogygia transform digest ${detOk ? `IDENTICAL across all ${N} builds ✓ (${runs[0].ssr.transformFiles}+${runs[0].client.transformFiles} files)` : `${hashes.size} distinct: [${[...hashes].join(', ')}]`}`);
console.log(`  (bundle-level hashing is intentionally NOT the signal — Vite8/rolldown chunk-splitting is non-deterministic upstream; a plain SvelteKit app fails that too)`);
if (!detOk) process.exitCode = 1;
