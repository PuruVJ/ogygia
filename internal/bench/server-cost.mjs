// SERVER-COST BENCH: ogygia's per-request overhead at a large CMS page shape.
// Starts the built playground (`vite preview`) under --cpu-prof, hammers /bench-cms and its plain twin,
// reports p50/p95 latency per route, HTML size, RSS over time (memory-flat check), then folds the CPU
// profile into self-time by function for ogygia's own source files.
// Usage (from repo root, after `pnpm --filter playground build`):
//   node internal/bench/server-cost.mjs [requests=300] [concurrency=4]
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUESTS = Number(process.argv[2] ?? 300);
const CONC = Number(process.argv[3] ?? 4);
const PORT = 4179;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'apps/playground');
const prof_dir = path.join(root, 'internal/bench/results/server-cost-prof');
fs.rmSync(prof_dir, { recursive: true, force: true });
fs.mkdirSync(prof_dir, { recursive: true });

// Launch vite's bin DIRECTLY under this node (not via pnpm) so --cpu-prof profiles the server process
// and the profile is flushed on SIGINT.
const vite_bin = path.join(app, 'node_modules/vite/bin/vite.js');
const server = spawn(process.execPath, [`--cpu-prof`, `--cpu-prof-dir=${prof_dir}`, `--cpu-prof-interval=200`, vite_bin, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
	cwd: app,
	env: { ...process.env, ORIGIN: `http://127.0.0.1:${PORT}` },
	stdio: ['ignore', 'pipe', 'pipe']
});
let server_out = '';
server.stdout.on('data', (d) => (server_out += d));
server.stderr.on('data', (d) => (server_out += d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
	try { await fetch(base + '/bench-cms/plain'); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
	if (i === 99) { console.error('server never came up\n' + server_out); process.exit(1); }
}
const rss = () => { try { return Number(execSync(`ps -o rss= -p ${server.pid}`).toString().trim()) / 1024; } catch { return 0; } };

async function hammer(route) {
	const times = [];
	let bytes = 0;
	let next = 0;
	// warm-up
	for (let i = 0; i < 10; i++) await fetch(base + route).then((r) => r.text());
	const rss0 = rss();
	const rss_samples = [];
	const worker = async () => {
		while (next < REQUESTS) {
			const i = next++;
			const t = performance.now();
			const r = await fetch(base + route);
			const body = await r.text();
			times.push(performance.now() - t);
			bytes = body.length;
			if (i % 50 === 0) rss_samples.push([i, Math.round(rss())]);
		}
	};
	await Promise.all(Array.from({ length: CONC }, worker));
	times.sort((a, b) => a - b);
	const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1);
	return { p50: p(0.5), p95: p(0.95), p99: p(0.99), min: times[0].toFixed(1), bytes, rss0: Math.round(rss0), rss_samples, rss1: Math.round(rss()) };
}

console.log(`server-cost bench · ${REQUESTS} requests × ${CONC} concurrent per route`);
const results = {};
for (const route of ['/bench-cms/plain', '/bench-cms', '/bench-cms/plain', '/bench-cms']) {
	const r = await hammer(route);
	results[route] = r;
	console.log(`  ${route.padEnd(18)} html ${(r.bytes / 1024).toFixed(0).padStart(5)} KB · min ${r.min} · p50 ${r.p50} · p95 ${r.p95} · p99 ${r.p99} ms · RSS ${r.rss0} → ${r.rss1} MB (${r.rss_samples.map(([i, m]) => m).join(',')})`);
}
const over = (k) => (Number(results['/bench-cms'][k]) - Number(results['/bench-cms/plain'][k])).toFixed(1);
console.log(`\n  ogygia overhead per request: min +${over('min')} ms · p50 +${over('p50')} ms · p95 +${over('p95')} ms · html +${((results['/bench-cms'].bytes - results['/bench-cms/plain'].bytes) / 1024).toFixed(0)} KB`);

server.kill('SIGINT');
await new Promise((r) => server.on('exit', r));
// Fold the CPU profile(s): self time by function, ogygia source files first.
const profiles = fs.readdirSync(prof_dir).filter((f) => f.endsWith('.cpuprofile'));
const self_by_fn = new Map();
const self_by_file = new Map();
let total = 0;
for (const f of profiles) {
	const p = JSON.parse(fs.readFileSync(path.join(prof_dir, f), 'utf8'));
	const nodes = new Map(p.nodes.map((n) => [n.id, n]));
	const hits = new Map();
	for (let i = 0; i < p.samples.length; i++) hits.set(p.samples[i], (hits.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
	for (const [id, us] of hits) {
		const n = nodes.get(id);
		const url = n.callFrame.url || '';
		total += us;
		const file = url ? url.replace(/^file:\/\//, '').replace(root + '/', '') : `(${n.callFrame.functionName || 'native'})`;
		const short = file.replace(/.*node_modules\//, 'nm:').replace(/\?.*$/, '');
		self_by_file.set(short, (self_by_file.get(short) ?? 0) + us / 1000);
		const fk = `${n.callFrame.functionName || '(anon)'}  ${short}:${n.callFrame.lineNumber + 1}`;
		self_by_fn.set(fk, (self_by_fn.get(fk) ?? 0) + us / 1000);
	}
}
const top = (m, n, filter = () => true) => [...m.entries()].filter(([k]) => filter(k)).sort((a, b) => b[1] - a[1]).slice(0, n);
console.log(`\nCPU profile: ${profiles.length} file(s), ${Math.round(total / 1000)} ms sampled\n  self time by file (top 25):`);
for (const [k, v] of top(self_by_file, 25)) console.log(`   ${String(Math.round(v)).padStart(7)} ms  ${k}`);
console.log(`\n  hottest functions in ogygia's own code (top 30):`);
const is_og = (k) => /packages\/ogygia\/|nm:ogygia\/|ogygia\/dist|ogygia\/src|Region\.svelte|og-region/.test(k);
for (const [k, v] of top(self_by_fn, 30, is_og)) console.log(`   ${String(Math.round(v)).padStart(7)} ms  ${k}`);
console.log(`\n  hottest functions overall (top 25):`);
for (const [k, v] of top(self_by_fn, 25)) console.log(`   ${String(Math.round(v)).padStart(7)} ms  ${k}`);
