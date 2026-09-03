// PURE csr=true app (apps/pure-csr): NO route sets csr=false, so ogygia emits no runtime chunk.
// A component there uses `<Region>` DIRECTLY around an interactive dual — the path that, on a mixed
// app, ships the runtime + an `<ogygia-region>`. Here the runtime is never built. The guarantee:
// the app must still WORK — the page renders, and Kit hydrates the inner component. ogygia gets out
// of the way and Kit owns hydration.
//
// Self-contained: builds apps/pure-csr, asserts the build shape, serves it, probes a browser, tears
// down. Registered in run.ts with needsServer:false (it manages its own server).
//
//   pnpm exec playwright test pure-csr

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check, sleep } from './fixtures/index.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const app = path.join(repo, 'apps/pure-csr');
const vite = path.join(app, 'node_modules/.bin/vite');
const PORT = 3061;
const BASE = `http://localhost:${PORT}`;

const OG_RUNTIME_CHUNK_RE = /(?:^|\/)og-runtime\.[0-9a-f]+\.js$/;
const OG_RUNTIME_URL_RE = /og-runtime\./;

let built: SpawnSyncReturns<string> | undefined;
let server: SpawnedServer | undefined;
let boot_error = '';

test.describe('pure csr=true app: direct interactive <Region> degrades to Kit, no runtime chunk', () => {
	test.beforeAll(async () => {
		test.setTimeout(15 * 60_000);
		// ── 1. build ───────────────────────────────────────────────────────────────
		built = spawnSync(vite, ['build'], { cwd: app, encoding: 'utf-8' });

		// ── 3. serve (booted here so the probe below runs against it; the script polled 100 × 300ms) ──
		try {
			server = await spawn_server({
				cmd: vite,
				args: ['preview', '--port', String(PORT), '--strictPort'],
				cwd: app,
				env: { ORIGIN: BASE },
				url: BASE + '/',
				timeout_ms: 30_000
			});
		} catch (e) {
			boot_error = String((e as Error)?.message || e);
		}
	});
	test.afterAll(() => server?.kill());

	test('build: pure csr=true app builds without error', () => {
		check(
			'build: pure csr=true app builds without error',
			built?.status === 0,
			built?.status === 0 ? '' : (built?.stderr || '').slice(-300)
		);
	});

	// ── 2. build shape ─────────────────────────────────────────────────────────
	test('build shape: NO ogygia runtime chunk emitted', () => {
		const clientImmutable = path.join(app, '.svelte-kit/output/client/_app/immutable');
		if (fs.existsSync(clientImmutable)) {
			const files: string[] = [];
			const walk = (d: string) => {
				for (const e of fs.readdirSync(d, { withFileTypes: true })) {
					const f = path.join(d, e.name);
					if (e.isDirectory()) walk(f);
					else files.push(path.relative(clientImmutable, f));
				}
			};
			walk(clientImmutable);
			const runtimeChunks = files.filter((f) => OG_RUNTIME_CHUNK_RE.test(f));
			check(
				'build: NO ogygia runtime chunk emitted (pure csr=true → ogygia ships nothing)',
				runtimeChunks.length === 0,
				runtimeChunks.join(', ') || '(none)'
			);
		} else {
			check('build: client output exists', false, clientImmutable);
		}
	});

	// ── 3. serve + browser probe ───────────────────────────────────────────────
	test('serve + browser probe: the region renders inline in the Kit tree, Kit hydrates it, nothing 404s', async ({
		page
	}) => {
		check('serve: preview server came up', !!server, boot_error);
		if (!server) return;

		const pageErrs: string[] = [];
		const runtime404: string[] = [];
		page.on('pageerror', (e) => pageErrs.push(e.message));
		page.on('response', (r) => {
			if (r.status() >= 400 && OG_RUNTIME_URL_RE.test(r.url()))
				runtime404.push(`${r.status()} ${r.url()}`);
		});

		await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60000 });
		const widget = page.locator('[data-inner-widget]');
		await widget.waitFor({ timeout: 8000 }).catch(() => {});
		const before = ((await widget.textContent().catch(() => '')) || '').trim();
		await widget.click().catch(() => {});
		await widget.click().catch(() => {});
		await sleep(200);
		const after = ((await widget.textContent().catch(() => '')) || '').trim();
		const dom = await page.evaluate(() => ({
			regionInside: document.querySelectorAll('[data-region-inside]').length,
			widget: document.querySelectorAll('[data-inner-widget]').length,
			regionEls: document.querySelectorAll('ogygia-region').length,
			runtimeScript: !!document.querySelector('script[data-ogygia-runtime]')
		}));

		// The guarantee: the region renders inline in the Kit tree, Kit hydrates it, nothing 404s.
		check('run: page did NOT crash (no page errors)', pageErrs.length === 0, pageErrs[0] ?? '');
		check(
			'run: RegionInside + widget each rendered once (no double render)',
			dom.regionInside === 1 && dom.widget === 1,
			`regionInside=${dom.regionInside} widget=${dom.widget}`
		);
		check('run: inner widget SSR value (start=3)', before.includes('count is 3'), before);
		check('run: inner widget hydrated by Kit (2 clicks → 5)', after.includes('count is 5'), after);
		check(
			'run: ZERO <ogygia-region> — the region rendered inline in the Kit tree',
			dom.regionEls === 0,
			`els=${dom.regionEls}`
		);
		check(
			'run: NO ogygia runtime script emitted (so nothing 404s)',
			dom.runtimeScript === false,
			`runtime=${dom.runtimeScript}`
		);
		check(
			'run: no runtime 404 (the pure-csr wart is gone)',
			runtime404.length === 0,
			runtime404[0] ?? ''
		);
	});
});
