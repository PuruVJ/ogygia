// EVERY ANSWER KEY, ONE COMMAND. Each key plants known problems on a playground page and checks the
// devtools or the profiler name exactly those — and each wants its own server (a devtools dev server,
// a devtools build, a plain build with the profiler's key). Run them all after any change to the
// beacon, the page analysis, the score or the report: a key nobody ran let a score regression sit
// for four rounds.
//
//   node internal/bench/all-keys.mjs            every key (builds twice: ~10 min)
//   node internal/bench/all-keys.mjs --quick    the dev-server keys only (~2 min)
//
// Ends with the playground built WITHOUT devtools (the e2e suite expects that). Logs per key in
// $TMPDIR/ogygia-keys/<key>.log; the summary prints the failing lines. Exit code 1 on any failure.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const app = join(repo, 'apps', 'playground');
const logs = join(tmpdir(), 'ogygia-keys');
mkdirSync(logs, { recursive: true });
const quick = process.argv.includes('--quick');
// (not 4190: the fetch standard's blocked-ports list refuses it — "bad port")
const DEV = 4194;
const BUILT = 4196;

/** run to completion; resolves { code, out } */
function run(cmd, args, opts = {}) {
	return new Promise((ok) => {
		const child = spawn(cmd, args, { cwd: opts.cwd ?? repo, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('close', (code) => ok({ code: code ?? 1, out }));
	});
}

/** a long-lived server; resolves its handle once `probe` answers */
async function serve(args, env, port, probe) {
	const child = spawn(process.execPath, args, { cwd: app, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (out += d));
	for (let i = 0; i < 180; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}${probe}`)).ok) return { stop: () => child.kill('SIGKILL'), log: () => out };
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	child.kill('SIGKILL');
	throw new Error(`server on ${port} did not start:\n${out.slice(-1500)}`);
}

const results = [];
async function key(name, cmd, args, opts) {
	const t = Date.now();
	const { code, out } = await run(cmd, args, opts);
	writeFileSync(join(logs, `${name}.log`), out);
	const bad = out.split('\n').filter((l) => l.startsWith('✗') || l.includes('FAILED') || l.includes('Error:'));
	results.push({ name, ok: code === 0, s: Math.round((Date.now() - t) / 1000), bad: bad.slice(0, 6) });
	console.log(`${code === 0 ? '✓' : '✗'} ${name} (${Math.round((Date.now() - t) / 1000)} s)`);
}

const build = async (env) => {
	const r = await run('pnpm', ['build'], { cwd: app, env });
	if (r.code !== 0) throw new Error('playground build failed:\n' + r.out.slice(-2000));
};

// 1 · the dev-server keys (devtools on)
{
	const dev = await serve(['node_modules/vite/bin/vite.js', 'dev', '--port', String(DEV), '--host', '127.0.0.1', '--strictPort'], { OGYGIA_DEVTOOLS: '1', ORIGIN: `http://127.0.0.1:${DEV}` }, DEV, '/dt-lab');
	// warm every lab page (the first visit after a start re-optimizes deps and reloads)
	for (const p of ['/dt-lab', '/dt-session', '/dt-third', '/dt-nest', '/dt-styles', '/dt-many']) await fetch(`http://127.0.0.1:${DEV}${p}`).catch(() => {});
	await new Promise((r) => setTimeout(r, 3000));
	try {
		await key('devtools page + profiler report + third parties + styles', process.execPath, ['internal/bench/devtools-answer-key.mjs', `http://127.0.0.1:${DEV}`, '--repeat=3']);
		await key('devtools record session', process.execPath, ['internal/bench/devtools-session-key.mjs', `http://127.0.0.1:${DEV}`]);
		await key('devtools accessibility (axe + contrast)', process.execPath, ['internal/bench/devtools-a11y-check.mjs', `http://127.0.0.1:${DEV}`]);
		await key('devtools: every press does something', process.execPath, ['internal/bench/devtools-click-check.mjs', `http://127.0.0.1:${DEV}`]);
	} finally {
		dev.stop();
	}
}

if (!quick) {
	// 1b · island files across deploys: three real builds, a browser that keeps its immutable cache
	// (it builds and serves on its own; the steps below rebuild after it)
	await key('island files across deploys (the cache check)', process.execPath, ['internal/bench/cache-bust-check.mjs']);
	// 2 · devtools in a build
	await build({ OGYGIA_DEVTOOLS: '1' });
	{
		const pv = await serve(['node_modules/vite/bin/vite.js', 'preview', '--port', String(BUILT), '--host', '127.0.0.1', '--strictPort'], { ORIGIN: `http://127.0.0.1:${BUILT}` }, BUILT, '/dt-lab');
		try {
			await key('devtools in a build', process.execPath, ['internal/bench/devtools-build-check.mjs', `http://127.0.0.1:${BUILT}`]);
		} finally {
			pv.stop();
		}
	}
	// 3 · the profiler on a plain build (and the playground left built without devtools)
	await build({});
	{
		const pv = await serve(['node_modules/vite/bin/vite.js', 'preview', '--port', String(BUILT), '--host', '127.0.0.1', '--strictPort'], { ORIGIN: `http://127.0.0.1:${BUILT}`, OGYGIA_PROFILER_SECRET: 'hell', OGYGIA_PROFILES_DB: join(logs, 'keys.db') }, BUILT, '/dt-lab');
		try {
			await key('profiler page score (twins)', process.execPath, ['internal/bench/profiler-score-key.mjs', `http://127.0.0.1:${BUILT}`, 'hell']);
			await key('profiler report links open their rows', process.execPath, ['internal/bench/profiler-links-check.mjs', `http://127.0.0.1:${BUILT}`, 'hell']);
			await key('profiler: every press does something', process.execPath, ['internal/bench/profiler-click-check.mjs', `http://127.0.0.1:${BUILT}`, 'hell']);
		} finally {
			pv.stop();
		}
	}
	await key('profiler slow patterns', process.execPath, ['internal/bench/profiler-answer-key.mjs', '--serve']);
}

console.log('\n' + results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name.padEnd(48)} ${String(r.s).padStart(4)} s${r.ok ? '' : '\n    ' + r.bad.join('\n    ')}`).join('\n'));
console.log(`logs: ${logs}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
