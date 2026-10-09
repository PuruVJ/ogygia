/**
 * `ogygia perf` and `ogygia bisect` — the runners around the pure modules. Loaded by the CLI on
 * demand (a sibling in dist), so the CLI bundle stays small.
 *
 *   ogygia perf --url http://127.0.0.1:4173 --pages /,/docs [--runs 5] [--key $SECRET]
 *               [--baseline perf-baseline.json] [--budget budget.json] [--out perf-snapshot.json]
 *               [--md perf-comment.md] [--label "$GITHUB_SHA"] [--no-fail]
 *
 *   ogygia bisect --good <sha> --bad <sha> --page /slow --build "pnpm build" --start "node build"
 *                 --url http://127.0.0.1:3000 [--key $SECRET] [--runs 3] [--margin 0.5] [--ready 30000]
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { measure, type PerfSnapshot } from './measure.js';
import { verdict, type Budget } from './compare.js';
import { markdown, summary } from './report.js';
import { bisect } from './bisect.js';

function arg(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	if (i === -1) return undefined;
	const v = argv[i + 1];
	return v && !v.startsWith('--') ? v : '';
}
const has = (argv: string[], name: string) => argv.includes(name);

function read_json<T>(file: string | undefined): T | null {
	if (!file || !existsSync(file)) return null;
	return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export async function runPerf(argv: string[]): Promise<number> {
	const url = arg(argv, '--url');
	const pages = (arg(argv, '--pages') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const pages_file = arg(argv, '--pages-file');
	if (pages_file) {
		const list = read_json<string[] | { pages: string[] }>(pages_file);
		if (Array.isArray(list)) pages.push(...list);
		else if (list?.pages) pages.push(...list.pages);
	}
	if (!url || !pages.length) {
		process.stderr.write('ogygia perf: --url <origin> and --pages /a,/b (or --pages-file) are required\n');
		return 2;
	}
	const runs = Number(arg(argv, '--runs')) || 5;
	const key = arg(argv, '--key') ?? process.env.OGYGIA_PROFILER_SECRET;
	const base = arg(argv, '--base');
	const label = arg(argv, '--label');
	const budget = read_json<Budget>(arg(argv, '--budget')) ?? {};
	const baseline = read_json<PerfSnapshot>(arg(argv, '--baseline'));
	process.stdout.write(`ogygia perf · ${pages.length} page${pages.length === 1 ? '' : 's'} × ${runs} runs on ${url}${baseline ? ' · against the baseline' : ' · no baseline (caps only)'}\n`);
	let snap: PerfSnapshot;
	try {
		snap = await measure({ url, pages, runs, key, base, label, on_page: (p) => process.stdout.write(`  measured ${p.page}: ${p.render_p50.toFixed(1)} ms\n`) });
	} catch (e) {
		process.stderr.write(`ogygia perf: ${e instanceof Error ? e.message : String(e)}\n`);
		return 2;
	}
	const out = arg(argv, '--out');
	if (out) writeFileSync(out, JSON.stringify(snap, null, 2));
	const v = verdict(baseline, snap, budget);
	const md = arg(argv, '--md');
	if (md) writeFileSync(md, markdown(v, { title: label ? `Performance (${label})` : 'Performance' }));
	process.stdout.write(summary(v) + '\n');
	if (out) process.stdout.write(`snapshot: ${out}${md ? ` · comment: ${md}` : ''}\n`);
	return v.ok || has(argv, '--no-fail') ? 0 : 1;
}

function sh(cmd: string, cwd: string, timeout_ms: number): void {
	execSync(cmd, { cwd, stdio: 'inherit', timeout: timeout_ms, env: { ...process.env, CI: '1' } });
}

/** Start a server command, wait until `url` answers (or `ready_ms`), return a stopper. */
async function serve(cmd: string, cwd: string, url: string, ready_ms: number): Promise<() => void> {
	const child = spawn(cmd, { cwd, shell: true, stdio: 'ignore', detached: true, env: { ...process.env } });
	const stop = () => {
		try {
			if (child.pid) process.kill(-child.pid, 'SIGTERM');
		} catch {
			/* gone */
		}
	};
	const until = Date.now() + ready_ms;
	while (Date.now() < until) {
		try {
			const res = await fetch(url, { redirect: 'manual' });
			if (res.status < 500) return stop;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	stop();
	throw new Error(`server did not answer at ${url} within ${ready_ms} ms`);
}

export async function runBisect(argv: string[]): Promise<number> {
	const good = arg(argv, '--good');
	const bad = arg(argv, '--bad') ?? 'HEAD';
	const page = arg(argv, '--page');
	const build = arg(argv, '--build');
	const start = arg(argv, '--start');
	const url = arg(argv, '--url');
	if (!good || !page || !build || !start || !url) {
		process.stderr.write('ogygia bisect: --good <sha> --page /x --build "<cmd>" --start "<cmd>" --url <origin> are required (--bad defaults to HEAD)\n');
		return 2;
	}
	const runs = Number(arg(argv, '--runs')) || 3;
	const key = arg(argv, '--key') ?? process.env.OGYGIA_PROFILER_SECRET;
	const margin = Number(arg(argv, '--margin')) || 0.5;
	const ready_ms = Number(arg(argv, '--ready')) || 60_000;
	const build_ms = Number(arg(argv, '--build-timeout')) || 15 * 60_000;
	const repo = process.cwd();
	const commits = execSync(`git rev-list --reverse ${good}..${bad}`, { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
	if (!commits.length) {
		process.stderr.write(`ogygia bisect: no commits between ${good} and ${bad}\n`);
		return 2;
	}
	process.stdout.write(`ogygia bisect · ${commits.length} commits between ${good.slice(0, 7)} and ${bad.slice(0, 7)} · page ${page}\n`);
	const worktree = mkdtempSync(path.join(tmpdir(), 'ogygia-bisect-'));
	// a holder, not a `let`: the closure below assigns it and the finally at the end reads it
	const running: { stop: (() => void) | null } = { stop: null };
	const measure_sha = async (sha: string): Promise<number | null> => {
		try {
			const dir = path.join(worktree, sha.slice(0, 12));
			if (!existsSync(dir)) sh(`git worktree add --detach "${dir}" ${sha}`, repo, 60_000);
			try {
				sh(build, dir, build_ms);
			} catch {
				process.stdout.write(`  ${sha.slice(0, 7)}: build failed — skipped\n`);
				return null;
			}
			running.stop = await serve(start, dir, url, ready_ms);
			try {
				const snap = await measure({ url, pages: [page], runs, key });
				return snap.pages[0].render_p50;
			} finally {
				running.stop();
				running.stop = null;
			}
		} catch (e) {
			process.stdout.write(`  ${sha.slice(0, 7)}: ${e instanceof Error ? e.message : String(e)} — skipped\n`);
			return null;
		} finally {
			try {
				sh(`git worktree remove --force "${path.join(worktree, sha.slice(0, 12))}"`, repo, 60_000);
			} catch {
				/* already gone */
			}
		}
	};
	try {
		const good_sha = execSync(`git rev-parse ${good}`, { cwd: repo, encoding: 'utf8' }).trim();
		const bad_sha = execSync(`git rev-parse ${bad}`, { cwd: repo, encoding: 'utf8' }).trim();
		process.stdout.write(`  measuring the ends…\n`);
		const good_value = await measure_sha(good_sha);
		const bad_value = await measure_sha(bad_sha);
		if (good_value === null || bad_value === null) {
			process.stderr.write('ogygia bisect: could not measure the good or the bad end\n');
			return 2;
		}
		process.stdout.write(`  good ${good_value.toFixed(1)} ms · bad ${bad_value.toFixed(1)} ms\n`);
		const result = await bisect({
			commits,
			good_value,
			bad_value,
			margin,
			measure: measure_sha,
			on_step: (s) => process.stdout.write(`  ${s.sha.slice(0, 7)}: ${s.value === null ? 'skipped' : `${s.value.toFixed(1)} ms → ${s.bad ? 'bad' : 'good'}`} (${Math.round(s.ms / 1000)} s)\n`)
		});
		if (!result.culprit) {
			process.stdout.write(`no commit in the range crossed the bar (${result.bar.toFixed(1)} ms): the regression is not between these commits, or it is noise\n`);
			return 1;
		}
		const subject = execSync(`git log -1 --format=%s ${result.culprit}`, { cwd: repo, encoding: 'utf8' }).trim();
		process.stdout.write(`\nfirst bad commit: ${result.culprit.slice(0, 7)} — ${subject}\n${result.last_good ? `last good: ${result.last_good.slice(0, 7)}\n` : ''}bar: ${result.bar.toFixed(1)} ms · ${result.steps.length} steps${result.skipped.length ? ` · skipped ${result.skipped.length}` : ''}\n`);
		return 0;
	} finally {
		running.stop?.();
		rmSync(worktree, { recursive: true, force: true });
	}
}
