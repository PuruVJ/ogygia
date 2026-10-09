// THE SWEEP: profile every playground route once (runs=2) and print its status and the slow
// patterns found — a crash or a pattern firing on a page it should not is what to look for. The
// answer-key pages (planted patterns) and the slow/lab fixtures are skipped.
//
//   cd apps/playground && PROFILER_SOURCEMAPS=1 pnpm build
//   OGYGIA_PROFILER_SECRET=hell ORIGIN=http://127.0.0.1:4181 node node_modules/vite/bin/vite.js preview --port 4181
//   node internal/bench/profiler-sweep.mjs
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const skip = new Set(['hell', 'inferno', 'latecomer', 'purgatory', 'purgatory-fixed','api', 'lab', 'rtr', 'rs', 'bench-cms', 'slow-io', 'nettest']);
const dir = fileURLToPath(new URL('../../apps/playground/src/routes', import.meta.url));
const routes = readdirSync(dir).filter((r) => !r.startsWith('+') && !r.startsWith('(') && !skip.has(r));
const kinds = new Map();
const warns = new Map();
for (const r of routes) {
	const t = Date.now();
	try {
		const res = await fetch(`http://127.0.0.1:4181/__profiler/page?p=/${r}&runs=2&format=json`, { headers: { 'x-profiler-key': 'hell' } });
		if (!res.ok) { console.log(`${r.padEnd(22)} HTTP ${res.status} ${(await res.text()).slice(0, 100)}`); continue; }
		const j = await res.json();
		const ks = (j.patterns ?? []).map((p) => p.kind);
		for (const k of ks) kinds.set(k, [...(kinds.get(k) ?? []), r]);
		// (the warnings too, by code: a finding firing on a page it should not is the same signal)
		for (const f of j.findings ?? []) if (f.severity === 'warn' || f.severity === 'error') warns.set(f.code, [...(warns.get(f.code) ?? []), r]);
		// one render: the median of the profiled runs (the report has no single render field)
		const runs = [...(j.target?.runs ?? [])].sort((a, b) => a - b);
		const render = runs.length ? runs[runs.length >> 1] : 0;
		console.log(`${r.padEnd(22)} ${String(Date.now() - t).padStart(6)}ms status ${j.target?.run_status ?? '?'} render ${Math.round(render)} patterns: ${ks.join(', ') || '-'}`);
	} catch (e) {
		console.log(`${r.padEnd(22)} ERROR ${e.message}`);
	}
}
console.log('\nby kind:');
for (const [k, rs] of kinds) console.log(`  ${k}: ${rs.join(' ')}`);
console.log('\nwarnings by code:');
for (const [k, rs] of [...warns].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${k} (${rs.length}): ${rs.join(' ')}`);
