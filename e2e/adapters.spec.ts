// ─────────────────────────────────────────────────────────────────────────────
// ogygia — adapter e2e suite.
//
// Proves an all-`csr = false` islands app (the case where Kit skips its client build, which ogygia
// keeps alive by injecting a URL-less keepalive route during the build) actually WORKS end to end on
// every adapter: builds the fixture with each adapter, boots the ACTUAL output on the closest
// offline emulator, and drives a real browser (island hydrates, runtime script serves, no errors).
// It also asserts the injected keepalive route is gone after each build (no leftover files).
//
//   pnpm exec playwright test adapters                            # all adapters
//   E2E_ADAPTERS=node,static pnpm exec playwright test adapters   # a subset (the old --only)
//   E2E_ADAPTERS_REUSE=1 pnpm exec playwright test adapters       # skip the ogygia rebuild+pack+install (the old --reuse)
//
// Reproducible locally and in CI (no vendor accounts). An adapter whose emulator tool isn't
// installed is SKIPPED, not failed.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { test, expect, check, sleep } from './fixtures/index.ts';
import { spawn_server } from './fixtures/servers.ts';

/** Thrown by a boot when the emulator's tool isn't installed — reported as SKIP, not FAIL. */
class SkipError extends Error {}
/** Thrown by the browser check's hard watchdog. */
class WatchdogError extends Error {}

const WORK_COPY_SKIP_RE = /node_modules|\.svelte-kit|(^|\/)build($|\/)|\.work/;
const RUNTIME_CHUNK_RE = /^og-runtime\..*\.js$/;
const SSR_TITLE_RE = /data-title/;
// Hash charset is Vite/rolldown's: hex plus the `-`/`_` that the feature-set busting adds a second
// segment with (e.g. `og-runtime.025962a09ea0-3d150168.js`). Keep it broad so a valid filename never
// reads as "none".
const RUNTIME_SRC_RE = /\/_app\/immutable\/og-runtime\.[\w-]+\.js/;
const HYDRATION_ERR_RE = /hydrat/i;
const TRAILING_SLASH_RE = /\/$/;

const cmd_exists = (cmd: string) =>
	spawnSync(
		process.platform === 'win32' ? 'where' : 'command',
		process.platform === 'win32' ? [cmd] : ['-v', cmd],
		{ shell: true }
	).status === 0;

const HERE = fileURLToPath(new URL('./adapters/', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const OGY = join(REPO, 'packages', 'ogygia');
const FIXTURE = join(HERE, 'fixture');
const WORK = join(HERE, '.work');
const APP = join(WORK, 'app');
// A fresh port per adapter (PORT_BASE + its index in ADAPTERS) so a server that's slow to release
// never blocks the next adapter from binding.
const PORT_BASE = 3097;

const only_list = (process.env.E2E_ADAPTERS ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const only = only_list.length ? only_list : undefined;
// Skip the ogygia rebuild+pack+install and reuse the prepared work app (fast iteration only).
const reuse = !!process.env.E2E_ADAPTERS_REUSE;

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): boolean {
	return spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
}

// ── static file server (adapter-static / prerendered output) ─────────────────
const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.map': 'application/json',
	'.txt': 'text/plain',
	'.woff2': 'font/woff2'
};
function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => resolve());
	});
}
function resolve_static(dir: string, url_path: string): string | null {
	const p = decodeURIComponent(url_path.split('?')[0]);
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
function static_server(dir: string) {
	// readFileSync + explicit Content-Length + Connection: close — small files, and no half-open
	// keep-alive sockets that hang a reused fetch (the streaming version deadlocked static/netlify/vercel).
	return createServer((req, res) => {
		const file = resolve_static(dir, req.url || '/');
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
type Bind = { port: number; base: string };
type Adapter = {
	name: string;
	buildAs?: string; // adapter to BUILD with (defaults to name) — 'bun' builds node output, run under bun
	boot?: (bind: Bind) => Promise<Booted>;
};

// Run the adapter-node server output under a given runtime binary (node or bun).
function boot_server(runtime: 'node' | 'bun'): (bind: Bind) => Promise<Booted> {
	return async ({ port, base }) => {
		if (runtime === 'bun' && !cmd_exists('bun'))
			throw new SkipError('bun not installed (CI installs it)');
		const srv = await spawn_server({
			cmd: runtime,
			args: ['build/index.js'],
			cwd: APP,
			env: { PORT: String(port), HOST: '127.0.0.1', ORIGIN: base },
			url: base,
			timeout_ms: 30_000,
			ready: (res) => res.status < 500
		});
		return { url: base, stop: () => srv.kill() };
	};
}

// Cloudflare: boot the REAL Workers runtime (workerd) via wrangler dev on the adapter's _worker.js +
// assets. Skips if wrangler/workerd isn't available locally (CI installs it).
async function boot_cloudflare({ port, base }: Bind): Promise<Booted> {
	// Only run when wrangler is on PATH or explicitly opted in (CI sets OGYGIA_E2E_WRANGLER) — avoids a
	// slow first-time `npx wrangler` download turning a local run into a failure.
	if (!cmd_exists('wrangler') && !process.env.OGYGIA_E2E_WRANGLER)
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
	const bin = cmd_exists('wrangler') ? 'wrangler' : 'npx';
	const args =
		bin === 'wrangler'
			? ['dev', '--port', String(port), '--ip', '127.0.0.1']
			: ['--yes', 'wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'];
	const srv = await spawn_server({
		cmd: bin,
		args,
		cwd: APP,
		env: { CI: '1', WRANGLER_SEND_METRICS: 'false' },
		url: base,
		timeout_ms: 60_000,
		ready: (res) => res.status < 500
	});
	return { url: base, stop: () => srv.kill() };
}

// Serve an adapter's real build-output directory (the exact files it deploys). For our prerendered
// island page this mirrors what each platform's asset layer does — the deployed artifact is booted,
// and the browser check proves ogygia's client (runtime + island chunks) is present and hydrates.
// In-process on purpose (the browser check is async, so the worker's event loop stays free to serve).
function boot_dir(rel: string): (bind: Bind) => Promise<Booted> {
	return async ({ port, base }) => {
		const dir = join(APP, rel);
		if (!existsSync(dir)) throw new Error(`output dir missing: ${rel}`);
		const server = static_server(dir);
		await listen(server, port);
		if (!(await wait_ready(base))) throw new Error('server never came up');
		return { url: base, stop: () => new Promise<void>((r) => server.close(() => r())) };
	};
}

async function wait_ready(url: string, timeout_ms = 30000): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout_ms) {
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

// Runtimes run the REAL server output (node + bun); cloudflare runs the REAL Workers runtime via
// wrangler/workerd; netlify/vercel serve the actual artifact each deploys (build/ and
// .vercel/output/static). auto emits no server without a platform → build-verify only.
const ADAPTERS: Adapter[] = [
	{ name: 'node', boot: boot_server('node') },
	{ name: 'bun', buildAs: 'node', boot: boot_server('bun') },
	{ name: 'static', boot: boot_dir('build') },
	{ name: 'cloudflare', boot: boot_cloudflare },
	{ name: 'netlify', boot: boot_dir('build') },
	{ name: 'vercel', boot: boot_dir('.vercel/output/static') },
	{ name: 'auto' }
];

// ── setup: build + pack ogygia, prepare a fixture work copy on the packed tarball ────────────────
function setup(): string {
	console.log('▸ building + packing ogygia');
	if (!run('pnpm', ['run', 'build'], { cwd: OGY })) throw new Error('ogygia build failed');
	mkdirSync(WORK, { recursive: true });
	const tgz = spawnSync('pnpm', ['pack', '--pack-destination', WORK], {
		cwd: OGY,
		encoding: 'utf8'
	})
		.stdout.trim()
		.split('\n')
		.pop()!
		.trim();
	const tarball = tgz.startsWith('/') ? tgz : join(WORK, tgz.split('/').pop()!);
	console.log(`  packed → ${tarball}`);

	console.log('▸ preparing fixture (real published shape)');
	rmSync(APP, { recursive: true, force: true });
	cpSync(FIXTURE, APP, {
		recursive: true,
		filter: (src) => !WORK_COPY_SKIP_RE.test(src)
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

// ── browser check (was e2e/adapters/browser-check.mjs) ───────────────────────────────────────────
// Behavior check for one booted adapter output.
// Proves the all-csr=false island actually WORKS end to end on this platform:
//   • the page is server-rendered (no Kit client bootstrap on a csr=false page),
//   • ogygia's runtime script — the one that used to 404 when Kit skipped the client build — loads,
//   • the island hydrates and is interactive (click increments),
//   • no console errors / hydration mismatches.

// The runtime + island scripts must actually serve (this is the regression the keepalive fixes).
async function status(url: string): Promise<number> {
	try {
		const r = await fetch(url);
		return r.status;
	} catch {
		return 0;
	}
}

async function drive(page: Page, base: string, errors: string[]) {
	const html = await (await fetch(base + '/')).text();
	check('page server-rendered (SSR HTML present)', SSR_TITLE_RE.test(html));

	const rt = html.match(RUNTIME_SRC_RE)?.[0];
	check('runtime script referenced in HTML', !!rt, rt || 'none');
	if (rt)
		check('runtime script serves 200 (the 404 regression)', (await status(base + rt)) === 200, rt);

	await page.goto(base + '/', { waitUntil: 'load', timeout: 15000 });
	const counter = page.locator('[data-counter]').first();
	await counter.waitFor({ timeout: 10000 });
	const before = (await counter.textContent())?.trim();
	check('island SSR text', before === 'count 10', JSON.stringify(before));

	await counter.click();
	await counter.click();
	const after = (await counter.textContent())?.trim();
	check(
		'island hydrated & interactive (click increments)',
		after === 'count 12',
		JSON.stringify(after)
	);

	check(
		'no hydration-mismatch errors',
		!errors.some((e) => HYDRATION_ERR_RE.test(e)),
		errors.filter((e) => HYDRATION_ERR_RE.test(e))[0] || ''
	);
	check('no console/page errors', errors.length === 0, errors[0] || '');
}

async function browser_check(browser: Browser, url: string) {
	const base = url.replace(TRAILING_SLASH_RE, '');
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(String(e)));
	// Hard watchdog: a browser check must never hang the whole suite.
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const timed_out = new Promise<never>((_, reject) => {
		watchdog = setTimeout(
			() => reject(new WatchdogError('browser check timed out (30s watchdog)')),
			30000
		);
	});
	const driving = drive(page, base, errors);
	try {
		await Promise.race([driving, timed_out]);
	} catch (err) {
		if (err instanceof WatchdogError) check(err.message, false);
		else check('browser check threw', false, String((err as Error)?.message ?? err));
	} finally {
		clearTimeout(watchdog);
		// A late rejection after the watchdog fired (the page is about to close) is not a second failure.
		driving.catch(() => {});
		await page.close();
	}
}

// ── per-adapter ──────────────────────────────────────────────────────────────
test.describe('adapters: an all-csr=false islands app works end to end on every SvelteKit adapter', () => {
	test.beforeAll(() => {
		test.setTimeout(15 * 60_000);
		if (reuse && existsSync(join(APP, 'node_modules', 'ogygia'))) {
			console.log('▸ reusing prepared work app (E2E_ADAPTERS_REUSE)');
		} else {
			setup();
		}
	});

	for (const [i, a] of ADAPTERS.entries()) {
		test(a.name, async ({ browser }) => {
			test.setTimeout(15 * 60_000);
			test.skip(
				!!only && !only.includes(a.name),
				`not selected by E2E_ADAPTERS=${process.env.E2E_ADAPTERS}`
			);
			const port = PORT_BASE + i; // fresh port per adapter — never wait on a previous server to release
			const base = `http://127.0.0.1:${port}`;

			// clean previous outputs
			for (const d of ['build', '.svelte-kit', '.vercel', '.netlify', '.wrangler'])
				rmSync(join(APP, d), { recursive: true, force: true });

			const built = run('node', ['node_modules/vite/bin/vite.js', 'build'], {
				cwd: APP,
				env: { ...process.env, OGYGIA_E2E_ADAPTER: a.buildAs ?? a.name }
			});
			expect(built, 'vite build succeeded').toBe(true);

			// injection cleanup: the keepalive route must be gone after the build
			const leftover = existsSync(join(APP, 'src', 'routes', '.ogygia-keep-client'));
			check('keepalive route cleaned up', !leftover);
			// client build alive: runtime chunk emitted
			const imm = join(APP, '.svelte-kit', 'output', 'client', '_app', 'immutable');
			const has_runtime = existsSync(imm) && readdirSync(imm).some((f) => RUNTIME_CHUNK_RE.test(f));
			check('ogygia runtime chunk emitted', has_runtime);

			// build-verify only — no server output for this adapter
			if (!a.boot) return;

			let booted: Booted;
			try {
				booted = await a.boot({ port, base });
			} catch (err) {
				if (err instanceof SkipError) test.skip(true, err.message);
				throw new Error(`boot: ${(err as Error)?.message ?? err}`);
			}
			try {
				await browser_check(browser, booted.url);
			} finally {
				await booted.stop();
				await sleep(300);
			}
		});
	}
});
