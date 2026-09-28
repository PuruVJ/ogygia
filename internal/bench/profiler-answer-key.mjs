// THE PROFILER'S ANSWER KEY: profile an annotated playground page and check the slow patterns the
// profiler reports against the page's own comments — every `PATTERN <kind>` comment is a problem
// it must find (`PATTERN-SMALL <kind>`: real, but near the 1 ms floor, so a miss only warns), every
// `DECOY` comment marks code it must NOT flag (`DECOY-GROWTH`: may sit on the memory card, but the
// growth check must not call it growing).
//
// One run against a preview you started:
//   cd apps/playground && pnpm build   (the server build writes hidden maps itself; PROFILER_NO_SOURCEMAPS=1: none)
//   OGYGIA_PROFILER_SECRET=hell ORIGIN=http://127.0.0.1:4181 node node_modules/vite/bin/vite.js preview --port 4181
//   node internal/bench/profiler-answer-key.mjs [--page=/hell] [base=http://127.0.0.1:4181] [key=hell]
//
// The whole thing, a fresh preview per page (a page that leaks on purpose cannot starve the next),
// each page profiled N times:
//   node internal/bench/profiler-answer-key.mjs --serve [--build] [--page=/inferno,/hell,/latecomer] [--repeat=3]
//
// Exit code 1 on a failure. With --repeat, a planted kind must be found in at least two runs of
// three (V8 can land an inlined function's time on a neighbouring line, and then that run cannot
// name it — docs: "Reading a report"); a decoy must be quiet in every run.
import { spawn, execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const serve = flags.includes('--serve');
const pages = (flag('page') ?? (serve ? '/inferno,/hell,/latecomer,/purgatory' : '/inferno')).split(',');
const repeat = Math.max(1, Number(flag('repeat') ?? (serve ? 3 : 1)));
const key = args[1] ?? 'hell';
const PORT = 4187;
const base = args[0] ?? (serve ? `http://127.0.0.1:${PORT}` : 'http://127.0.0.1:4181');
const app = fileURLToPath(new URL('../../apps/playground', import.meta.url));
const root = join(app, 'src');
// real, but under the report's 1 ms floor on a fast machine: V8 caches a regex, grows a string
// as a rope, and reads a small file quickly
const SMALL = new Set(['regexp-per-call', 'string-build', 'sync-io']);

/** The page's key, from its own comments. */
function key_of(page) {
	const name = page.replace(/^\//, '');
	const files = [];
	for (const dir of [`lib/${name}`, `routes/${name}`]) {
		const walk = (d) => {
			let entries;
			try {
				entries = readdirSync(d);
			} catch {
				return;
			}
			for (const n of entries) {
				const p = join(d, n);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|svelte)$/.test(n)) files.push(p);
			}
		};
		walk(join(root, dir));
	}
	const expected = new Map();
	// (`--no-maps` holds a build without maps to the same list: the source on disk is matched to the
	// chunks by text, so the kinds that read a load or a component line by line are found there too)
	const small = SMALL;
	const decoys = [];
	for (const abs of files) {
		const rel = relative(root, abs);
		const lines = readFileSync(abs, 'utf8').split('\n');
		lines.forEach((text, i) => {
			if (!/says which slow pattern/.test(text)) {
				for (const p of text.matchAll(/PATTERN(-SMALL)? ([a-z-]+)/g)) {
					if (p[1]) small.add(p[2]);
					const list = expected.get(p[2]) ?? [];
					list.push(`${rel}:${i + 1}`);
					expected.set(p[2], list);
				}
			}
			if (/\bDECOY\b/.test(text) && !/for a DECOY|plus DECOYS/.test(text)) {
				let end = i + 1;
				while (end < lines.length && lines[end].trim() !== '') end++;
				decoys.push({ rel, from: i + 2, to: end, growth: /DECOY-GROWTH/.test(text), note: text.trim().slice(0, 70) });
			}
		});
	}
	return { expected, small, decoys };
}

/** One profile of `page`, checked: the kinds found and the decoys flagged. */
async function check(page, k) {
	const headers = { 'x-profiler-key': key };
	const rec = await fetch(`${base}/__profiler/page?p=${page}&runs=3`, { headers, redirect: 'manual' });
	const id = rec.headers.get('location')?.split('/').pop();
	if (!id) throw new Error('no report: is the preview running with OGYGIA_PROFILER_SECRET, built with the profiler on?');
	const report = await (await fetch(`${base}/__profiler/report/${id}.json`, { headers })).json();
	const patterns = report.patterns ?? [];
	// a planted kind counts only where it was planted: in one of the files its comments are in (a
	// line of the site, or a caller line). The same kind somewhere else is not the answer
	const on_file = (p) => {
		// the whole page's own kinds: their sites are where the document changes, anywhere on it
		if (p.kind === 'same-document' || p.kind === 'almost-same-document') return true;
		const files = (k.expected.get(p.kind) ?? []).map((x) => x.slice(0, x.lastIndexOf(':')));
		if (!files.length) return true;
		// (a build without sourcemaps: its chunk line carries the source module it came from)
		const at = (x) => files.some((f) => (x.path ?? x.file ?? '').endsWith(f) || (x.module ?? '').endsWith(f));
		return (p.sites ?? []).some((s) => at(s) || (s.via ?? []).some(at));
	};
	const found = new Set(patterns.filter(on_file).map((p) => p.kind));
	const elsewhere = patterns.filter((p) => !on_file(p)).map((p) => `${p.kind} at ${(p.sites ?? []).map((s) => `${s.file}:${s.line}`).join(', ')}`);
	const flagged = [];
	for (const d of k.decoys) {
		for (const p of patterns) {
			if (d.growth && p.kind !== 'kept-per-render') continue;
			for (const s of p.sites ?? []) {
				// the site's own line — or, for a chain through a helper, a line that called it (the helper's
				// line is the site, the decoy's lines are `via`; other kinds on a shared helper, like its
				// same answer, are true of every caller and not what a decoy's lines claim)
				const inside = (p) => (p.path ?? p.file ?? '').endsWith(d.rel) && p.line >= d.from && p.line <= d.to;
				if (!inside(s) && !(p.kind === 'waits-in-a-row' && (s.via ?? []).some(inside))) continue;
				if (d.growth && s.grows !== true) continue;
				// ANSWER_KEY_DUMP=<dir>: keep the report that flagged it, to read why
				if (process.env.ANSWER_KEY_DUMP) {
					try {
						writeFileSync(`${process.env.ANSWER_KEY_DUMP}/flagged-${id}.json`, JSON.stringify(report));
					} catch {
						/* a dump is a convenience */
					}
				}
				flagged.push(
					`${d.rel}:${s.line} as ${p.kind}${d.growth ? ` (grows: ${s.grows})` : ''}  (${d.note}) — cpu ${s.cpu_ms} ms, alloc ${s.alloc_bytes} B${s.calls ? `, ${s.calls} calls` : ''}${s.lib_ms ? `, lib ${s.lib_ms} ms` : ''}${s.via?.length ? `, via ${s.via.map((v) => v.line).join(',')}` : ''}, report ${id}`
				);
			}
		}
	}
	return { id, found, flagged, elsewhere, forecast: report.forecast?.after_ms, answers: report.forecast?.answers?.after_ms, cpu_after: report.forecast?.cpu_after_ms, now: report.forecast?.now_ms, partial: !!report.forecast?.partial };
}

// THE FORECAST, HELD TO ACCOUNT: a page and its copy with the reported code fixes applied. The page's
// forecast ("one render after every fix") must match what the fixed copy measures — and its second
// figure ("keeping the services' answers too") what the copy measures keeping them (`cached`).
const FIXED = { '/latecomer': { fixed: '/latecomer-fixed' }, '/inferno': { fixed: '/inferno-fixed', cached: '/inferno-fixed%3Fcache%3D1' }, '/hell': { fixed: '/hell-fixed' }, '/purgatory': { fixed: '/purgatory-fixed' } };
/** a forecast is right within a quarter of itself, 8 ms, or 5 % of the render it started from —
 *  whichever is widest (a few ms left of a 550 ms render is a 5 % question, not a 25 % one) */
const close = (said, got, now) => said !== undefined && got !== undefined && Math.abs(got - said) <= Math.max(8, said * 0.25, (now ?? 0) * 0.05);
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** the last `measure`'s CPU a render (the fixed copy's timeline) */
let measured_cpu;

/** The fixed copy's measured render, the median over `repeat` profiles. */
async function measure(page, fresh = async () => {}) {
	const headers = { 'x-profiler-key': key };
	const ms = [];
	const cpu = [];
	for (let r = 0; r < repeat; r++) {
		// each on a fresh server: one profile renders the page several times, and a page that keeps
		// memory alive slows the next profile on the same heap
		await fresh();
		const rec = await fetch(`${base}/__profiler/page?p=${page}&runs=3`, { headers, redirect: 'manual' });
		const id = rec.headers.get('location')?.split('/').pop();
		const report = await (await fetch(`${base}/__profiler/report/${id}.json`, { headers })).json();
		const runs = report.target?.runs ?? report.meta?.runs ?? [];
		if (runs.length) ms.push(median(runs));
		// (the main thread's: what the forecast's figure is)
		if (typeof report.forecast?.cpu_now_ms === 'number') cpu.push(report.forecast.cpu_now_ms);
	}
	// the copy's CPU a render too: what the forecast's "CPU after every fix" is held to
	measured_cpu = cpu.length ? median(cpu) : undefined;
	return ms.length ? median(ms) : undefined;
}

/** Run the page `repeat` times and say what passed. */
async function run_page(page, fresh = async () => {}) {
	const k = key_of(page);
	const hits = new Map([...k.expected.keys()].map((kind) => [kind, 0]));
	const flagged = [];
	const extra = new Set();
	const forecasts = [];
	const cpu_afters = [];
	const answers = [];
	const nows = [];
	let partial = false;
	const elsewhere = new Set();
	for (let r = 0; r < repeat; r++) {
		const res = await check(page, k);
		if (res.forecast !== undefined) forecasts.push(res.forecast);
		if (res.cpu_after !== undefined) cpu_afters.push(res.cpu_after);
		if (res.answers !== undefined) answers.push(res.answers);
		if (res.now !== undefined) nows.push(res.now);
		if (res.partial) partial = true;
		for (const e of res.elsewhere) elsewhere.add(e);
		for (const kind of res.found) {
			if (hits.has(kind)) hits.set(kind, hits.get(kind) + 1);
			else extra.add(kind);
		}
		flagged.push(...res.flagged);
		if (repeat > 1) process.stdout.write(`  ${page} run ${r + 1}/${repeat}: report ${res.id}\n`);
	}
	const need = repeat === 1 ? 1 : Math.ceil((repeat * 2) / 3);
	let failed = 0;
	console.log(`\n${page}  (found in N of ${repeat} runs; a planted kind needs ${need})`);
	for (const [kind, n] of [...hits].sort()) {
		const small = k.small.has(kind);
		const ok = n >= need;
		if (!ok && !small) failed++;
		const tag = ok ? 'FOUND ' : small ? 'small ' : 'MISSED';
		console.log(`  ${tag} ${String(n).padStart(2)}/${repeat}  ${kind.padEnd(20)} ${k.expected.get(kind).join(', ')}`);
	}
	console.log(`  decoys: ${k.decoys.length}, ${flagged.length ? `FLAGGED ${flagged.length} time(s)` : 'all quiet in every run'}`);
	for (const f of [...new Set(flagged)]) console.log(`    FLAGGED ${f}`);
	failed += flagged.length ? 1 : 0;
	if (extra.size) console.log(`  also reported (not planted): ${[...extra].join(', ')}`);
	// a planted kind reported away from its files: a false alarm unless the page plants it there too
	for (const e of elsewhere) console.log(`  NOT WHERE PLANTED ${e}`);
	const pair = FIXED[page];
	const now = nows[0];
	const show = (x) => (x === undefined ? '?' : Math.round(x * 10) / 10);
	for (const [said_all, copy, what] of [
		[forecasts, pair?.fixed, 'after every fix'],
		[answers, pair?.cached, 'keeping the answers too']
	]) {
		if (!copy) continue;
		// the FIRST profile's forecast: the one on a fresh server, like the copy's (a later one ran on
		// the heap the earlier renders filled)
		const said = said_all[0];
		const got = await measure(copy, fresh);
		// a PARTIAL forecast (a build without sourcemaps sees fewer fixes) must only never promise more
		// than the fixes give: the fixed copy at or under it
		const ok = partial ? said !== undefined && got !== undefined && got <= said + Math.max(8, said * 0.25, (now ?? 0) * 0.05) : close(said, got, now);
		console.log(`  ${ok ? 'FORECAST' : 'FORECAST OFF'} ${show(said)} ms ${what}${partial ? ' (partial: no sourcemaps, a ceiling)' : ''} · ${decodeURIComponent(copy)} measures ${show(got)} ms`);
		if (!ok) failed++;
		// the CPU after every fix (what a core's throughput rides on), against the copy's CPU
		if (what === 'after every fix' && cpu_afters[0] !== undefined && measured_cpu !== undefined) {
			// (looser than the render's: a fix's replacement code costs CPU of its own, on lines the
			// original never had — /hell-fixed's one-pass renderer)
			const c_ok = Math.abs(measured_cpu - cpu_afters[0]) <= Math.max(6, measured_cpu * 0.35);
			console.log(`  ${c_ok ? 'CPU AFTER' : 'CPU AFTER OFF'} ${show(cpu_afters[0])} ms main-thread CPU · the copy's ${show(measured_cpu)} ms`);
			if (!c_ok) failed++;
		}
	}
	return failed;
}

/** A fresh preview on PORT, ready; returns a stopper. */
async function start_preview() {
	const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
		cwd: app,
		env: { ...process.env, OGYGIA_PROFILER_SECRET: key, ORIGIN: base },
		stdio: 'ignore'
	});
	for (let i = 0; i < 120; i++) {
		try {
			await fetch(base + '/');
			return () => child.kill();
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	child.kill();
	throw new Error('the preview did not start');
}

if (flags.includes('--build')) {
	execSync('pnpm build', { cwd: fileURLToPath(new URL('../../packages/ogygia', import.meta.url)), stdio: 'inherit' });
	// the DEFAULT build: with the profiler on, its server build writes hidden maps by itself.
	// `--no-maps`: a build with none (an app that set `build.sourcemap: false`) — the fallback path
	execSync('pnpm build', { cwd: app, stdio: 'inherit', env: { ...process.env, ...(flags.includes('--no-maps') ? { PROFILER_NO_SOURCEMAPS: '1' } : {}) } });
}
let failed = 0;
for (const page of pages) {
	let stop = serve ? await start_preview() : () => {};
	// a fixed copy is measured on a FRESH server: after the original's renders (/hell keeps ~60 MB
	// alive each) the heap is fuller and every render slower — 590 ms against 380 on a fresh one
	const fresh = async () => {
		if (!serve) return;
		stop();
		await new Promise((r) => setTimeout(r, 500));
		stop = await start_preview();
	};
	try {
		failed += await run_page(page, fresh);
	} finally {
		stop();
		if (serve) await new Promise((r) => setTimeout(r, 500));
	}
}
console.log(failed ? `\n${failed} problem(s)` : '\nall planted patterns found, no decoy flagged');
process.exit(failed ? 1 : 0);
