#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia — adapter e2e suite.
//
// Proves an all-`csr = false` islands app (the case where Kit skips its client build, which ogygia
// keeps alive by injecting a URL-less keepalive route during the build) actually WORKS end to end on
// every adapter: builds the fixture with each adapter, boots the ACTUAL output on the closest
// offline emulator, and drives a real browser (island hydrates, runtime script serves, no errors).
// It also asserts the injected keepalive route is gone after each build (no leftover files).
//
//   node verify/adapters/run.ts                 # all adapters
//   node verify/adapters/run.ts --only=node,static
//
// Reproducible locally and in CI (no vendor accounts). Exit code is non-zero if any adapter fails.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Thrown by a boot when the emulator's tool isn't installed — reported as SKIP, not FAIL. */
class SkipError extends Error {}
const cmdExists = (cmd: string) =>
	spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], { shell: true }).status === 0;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const OGY = join(REPO, 'packages', 'ogygia');
const FIXTURE = join(HERE, 'fixture');
const WORK = join(HERE, '.work');
const APP = join(WORK, 'app');
// A fresh port per adapter (bumped in testAdapter) so a server that's slow to release never blocks
// the next adapter from binding.
let PORT = Number(process.env.PORT || 3097);
let BASE = `http://127.0.0.1:${PORT}`;

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').map((s) => s.trim());
// Skip the ogygia rebuild+pack+install and reuse the prepared work app (fast iteration only).
const reuse = process.argv.includes('--reuse');
const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], opts: any = {}): boolean {
	return spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
}

async function waitReady(url: string, timeoutMs = 30000): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(url);
			if (r.status < 500) return true;
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	return false;
}

// ── static file server (adapter-static / prerendered output) ─────────────────
const MIME: Record<string, string> = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
	'.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain', '.woff2': 'font/woff2'
};
function listen(server: import('node:http').Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => resolve());
	});
}
function resolveStatic(dir: string, urlPath: string): string | null {
	const p = decodeURIComponent(urlPath.split('?')[0]);
	const candidates = p.endsWith('/')
		? [join(dir, p, 'index.html')]
		: [join(dir, p), join(dir, p + '.html'), join(dir, p, 'index.html')];
	for (const c of candidates) {
		try {
			if (statSync(c).isFile()) return c;
		} catch {
			/* try next */
		}
	}
	// Prerendered SPA-ish fallback for extensionless route requests only (never for missing assets).
	if (!extname(p)) {
		try {
			if (statSync(join(dir, 'index.html')).isFile()) return join(dir, 'index.html');
		} catch {
			/* none */
		}
	}
	return null;
}
function staticServer(dir: string) {
	// readFileSync + explicit Content-Length + Connection: close — small files, and no half-open
	// keep-alive sockets that hang a reused fetch (the streaming version deadlocked static/netlify/vercel).
	return createServer((req, res) => {
		const file = resolveStatic(dir, req.url || '/');
		res.setHeader('connection', 'close');
		if (!file) {
			res.statusCode = 404;
			return res.end('not found');
		}
		const body = readFileSync(file);
		res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
		res.setHeader('content-length', String(body.length));
		res.end(body);
	});
}

type Booted = { url: string; stop: () => void | Promise<void> };
type Adapter = {
	name: string;
	buildAs?: string; // adapter to BUILD with (defaults to name) — 'bun' builds node output, run under bun
	boot?: () => Promise<Booted>;
};

// Run the adapter-node server output under a given runtime binary (node or bun).
function bootServer(runtime: 'node' | 'bun'): () => Promise<Booted> {
	return async () => {
		if (runtime === 'bun' && !cmdExists('bun'))
			throw new SkipError('bun not installed (CI installs it)');
		const child = spawn(runtime, ['build/index.js'], {
			cwd: APP,
			stdio: 'pipe',
			env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ORIGIN: BASE }
		});
		if (!(await waitReady(BASE))) {
			child.kill('SIGKILL');
			throw new Error(`${runtime} server never came up`);
		}
		return { url: BASE, stop: () => void child.kill('SIGKILL') };
	};
}

// Cloudflare: boot the REAL Workers runtime (workerd) via wrangler dev on the adapter's _worker.js +
// assets. Skips if wrangler/workerd isn't available locally (CI installs it).
async function bootCloudflare(): Promise<Booted> {
	// Only run when wrangler is on PATH or explicitly opted in (CI sets OGYGIA_E2E_WRANGLER) — avoids a
	// slow first-time `npx wrangler` download turning a local run into a failure.
	if (!cmdExists('wrangler') && !process.env.OGYGIA_E2E_WRANGLER)
		throw new SkipError('wrangler not on PATH (set OGYGIA_E2E_WRANGLER=1 / CI runs it)');
	const out = join(APP, '.svelte-kit', 'cloudflare');
	if (!existsSync(join(out, '_worker.js'))) throw new Error('cloudflare _worker.js missing');
	// Minimal wrangler config pointing at the adapter output (worker + static assets binding).
	writeFileSync(
		join(APP, 'wrangler.jsonc'),
		JSON.stringify(
			{
				name: 'ogygia-fixture',
				main: '.svelte-kit/cloudflare/_worker.js',
				compatibility_date: '2024-11-01',
				compatibility_flags: ['nodejs_compat'],
				assets: { directory: '.svelte-kit/cloudflare', binding: 'ASSETS' }
			},
			null,
			2
		)
	);
	const bin = cmdExists('wrangler') ? 'wrangler' : 'npx';
	const args = bin === 'wrangler' ? ['dev', '--port', String(PORT), '--ip', '127.0.0.1']
		: ['--yes', 'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'];
	const child = spawn(bin, args, {
		cwd: APP,
		stdio: 'pipe',
		env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
	});
	if (!(await waitReady(BASE, 60000))) {
		child.kill('SIGKILL');
		throw new Error('wrangler dev never came up');
	}
	return { url: BASE, stop: () => child.kill('SIGTERM') };
}

// Serve an adapter's real build-output directory (the exact files it deploys). For our prerendered
// island page this mirrors what each platform's asset layer does — the deployed artifact is booted,
// and the browser check proves ogygia's client (runtime + island chunks) is present and hydrates.
function bootDir(rel: string): () => Promise<Booted> {
	return async () => {
		const dir = join(APP, rel);
		if (!existsSync(dir)) throw new Error(`output dir missing: ${rel}`);
		const server = staticServer(dir);
		await listen(server, PORT);
		if (!(await waitReady(BASE))) throw new Error('server never came up');
		return { url: BASE, stop: () => new Promise<void>((r) => server.close(() => r())) };
	};
}

// Runtimes run the REAL server output (node + bun); cloudflare runs the REAL Workers runtime via
// wrangler/workerd; netlify/vercel serve the actual artifact each deploys (build/ and
// .vercel/output/static). auto emits no server without a platform → build-verify only.
const ADAPTERS: Adapter[] = [
	{ name: 'node', boot: bootServer('node') },
	{ name: 'bun', buildAs: 'node', boot: bootServer('bun') },
	{ name: 'static', boot: bootDir('build') },
	{ name: 'cloudflare', boot: bootCloudflare },
	{ name: 'netlify', boot: bootDir('build') },
	{ name: 'vercel', boot: bootDir('.vercel/output/static') },
	{ name: 'auto' }
];

// ── setup: build + pack ogygia, prepare a fixture work copy on the packed tarball ────────────────
function setup(): string {
	console.log(`${BOLD}▸ building + packing ogygia${RESET}`);
	if (!run('pnpm', ['run', 'build'], { cwd: OGY })) throw new Error('ogygia build failed');
	mkdirSync(WORK, { recursive: true });
	const tgz = spawnSync('pnpm', ['pack', '--pack-destination', WORK], { cwd: OGY, encoding: 'utf8' })
		.stdout.trim().split('\n').pop()!.trim();
	const tarball = tgz.startsWith('/') ? tgz : join(WORK, tgz.split('/').pop()!);
	console.log(`  packed → ${DIM}${tarball}${RESET}`);

	console.log(`${BOLD}▸ preparing fixture (real published shape)${RESET}`);
	rmSync(APP, { recursive: true, force: true });
	cpSync(FIXTURE, APP, {
		recursive: true,
		filter: (src) => !/node_modules|\.svelte-kit|(^|\/)build($|\/)|\.work/.test(src)
	});
	const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
	pkg.dependencies.ogygia = `file:${tarball}`;
	writeFileSync(join(APP, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
	// pnpm exits non-zero on unapproved native build scripts (esbuild/workerd) even though the install
	// itself completes — and we don't need those binaries for a rolldown-based vite build. Verify the
	// install by PRESENCE, not exit code. (workerd IS needed for cloudflare; that adapter's boot
	// invokes wrangler, which fetches its own runtime.)
	run('pnpm', ['install', '--ignore-workspace', '--no-lockfile'], { cwd: APP });
	for (const dep of ['ogygia', 'vite', '@sveltejs/kit'])
		if (!existsSync(join(APP, 'node_modules', dep)))
			throw new Error(`fixture install failed — node_modules/${dep} missing`);
	return tarball;
}

// ── per-adapter ──────────────────────────────────────────────────────────────
type Result = 'pass' | 'fail' | 'skip';
async function testAdapter(a: Adapter): Promise<Result> {
	console.log(`\n${BOLD}══ ${a.name} ══${RESET}`);
	// clean previous outputs
	for (const d of ['build', '.svelte-kit', '.vercel', '.netlify', '.wrangler'])
		rmSync(join(APP, d), { recursive: true, force: true });

	const built = run('node', ['node_modules/vite/bin/vite.js', 'build'], {
		cwd: APP,
		env: { ...process.env, OGYGIA_E2E_ADAPTER: a.buildAs ?? a.name }
	});
	if (!built) {
		console.log(`  ${RED}✗ build failed${RESET}`);
		return 'fail';
	}

	// injection cleanup: the keepalive route must be gone after the build
	const leftover = existsSync(join(APP, 'src', 'routes', '.ogygia-keep-client'));
	console.log(`    ${leftover ? RED + 'FAIL' : GREEN + 'PASS'}${RESET}  keepalive route cleaned up`);
	// client build alive: runtime chunk emitted
	const imm = join(APP, '.svelte-kit', 'output', 'client', '_app', 'immutable');
	const hasRuntime = existsSync(imm) &&
		spawnSync('sh', ['-c', `ls ${imm}/og-runtime.*.js 2>/dev/null`], { encoding: 'utf8' }).stdout.trim() !== '';
	console.log(`    ${hasRuntime ? GREEN + 'PASS' : RED + 'FAIL'}${RESET}  ogygia runtime chunk emitted`);
	let ok = !leftover && hasRuntime;

	if (!a.boot) {
		console.log(`    ${DIM}(build-verify only — no server output for this adapter)${RESET}`);
		return ok ? 'pass' : 'fail';
	}

	let booted: Booted | null = null;
	try {
		booted = await a.boot();
		// MUST be async spawn, not spawnSync: static/netlify/vercel run their server IN THIS process,
		// and spawnSync would block the event loop so the server couldn't answer the browser.
		const code = await new Promise<number>((resolve) => {
			const child = spawn('node', [join(HERE, 'browser-check.mjs'), booted!.url], { stdio: 'inherit' });
			child.on('close', (c) => resolve(c ?? 1));
		});
		ok = ok && code === 0;
	} catch (err: any) {
		if (err instanceof SkipError) {
			console.log(`    ${DIM}SKIP  ${err.message}${RESET}`);
			return 'skip';
		}
		console.log(`    ${RED}FAIL  boot: ${err?.message ?? err}${RESET}`);
		ok = false;
	} finally {
		await booted?.stop();
		await sleep(300);
	}
	return ok ? 'pass' : 'fail';
}

// ── main ──────────────────────────────────────────────────────────────────────
const list = ADAPTERS.filter((a) => !only || only.includes(a.name));
if (reuse && existsSync(join(APP, 'node_modules', 'ogygia'))) {
	console.log(`${BOLD}▸ reusing prepared work app (--reuse)${RESET}`);
} else {
	setup();
}
const results: Array<[string, Result]> = [];
for (let i = 0; i < list.length; i++) {
	PORT = 3097 + i; // fresh port per adapter — never wait on a previous server to release
	BASE = `http://127.0.0.1:${PORT}`;
	results.push([list[i].name, await testAdapter(list[i])]);
}

console.log(`\n${BOLD}── adapter e2e summary ──${RESET}`);
for (const [name, r] of results) {
	const mark = r === 'pass' ? GREEN + '✓' : r === 'skip' ? DIM + '∅' : RED + '✗';
	console.log(`  ${mark}${RESET} ${name}${r === 'skip' ? DIM + ' (skipped)' + RESET : ''}`);
}
process.exit(results.some(([, r]) => r === 'fail') ? 1 : 0);
