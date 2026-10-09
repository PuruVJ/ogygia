// PAGE-CSR invariant, browser truth — a REAL build of internal/repro-deep-csr, the consumer
// shape that regressed: the root layout declares NO csr anywhere in its own chain; the ONLY
// `csr = false` lives in a deep catch-all (+ one explicit csr=true page → the layout's world is
// MIXED). The root chrome (Header counter island + headless Boot island) must:
//   · on /content/* (csr=false): render as real <ogygia-region>s and HYDRATE (the regression
//     stripped them to plain while Kit shipped no client — dead chrome);
//   · on /spa (csr=true): degrade to Kit-owned inline components, still interactive.
// Self-contained: builds the fixture app, boots its adapter-node output, checks, tears down.
// Usage: pnpm exec playwright test deep-csr
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test, expect, check } from './fixtures/index.ts';
import { REGION_OPEN_G_RE } from './fixtures/re.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = join(repo, 'internal', 'repro-deep-csr');
const PORT = 3071;
const base = `http://localhost:${PORT}`;

const CONTENT_PAGE_RE = /data-page="content"/;
const CHROME_HEADER_REGION_RE = /<ogygia-region[\s\S]*?data-chrome-header/;
const KIT_BOOT_RE = /__sveltekit_/;
const SPA_PAGE_RE = /data-page="spa"/;

let srv: SpawnedServer | undefined;

test.describe('PAGE-CSR invariant: csr=false ONLY in a deep catch-all — root-layout chrome still islands; mixed world degrades on the csr=true page (self-building fixture)', () => {
	test.beforeAll(async () => {
		test.setTimeout(15 * 60_000);
		// ── 1. build the fixture (its vite build consumes the live workspace ogygia) ────────────────
		const built = spawnSync('pnpm', ['--dir', dir, 'build'], { stdio: 'inherit' });
		expect(built.status, 'repro-deep-csr build').toBe(0);

		// ── 2. boot the adapter-node output ─────────────────────────────────────────────────────────
		srv = await spawn_server({
			cmd: 'node',
			args: ['build/index.js'],
			cwd: dir,
			env: { PORT: String(PORT), ORIGIN: base },
			url: base + '/spa',
			ready: (res) => res.ok
		});
	});
	test.afterAll(() => srv?.kill());

	// ── SSR: the csr=false world ──────────────────────────────────────────────────────────────
	test('SSR: the csr=false world', async () => {
		const content = await (await fetch(base + '/content/hello')).text();
		check('SSR /content: page rendered', CONTENT_PAGE_RE.test(content));
		check(
			'SSR /content: Header chrome is a REAL region (not stripped — the regression)',
			CHROME_HEADER_REGION_RE.test(content)
		);
		check(
			'SSR /content: headless Boot island region present',
			(content.match(REGION_OPEN_G_RE) || []).length >= 2,
			`regions=${(content.match(REGION_OPEN_G_RE) || []).length}`
		);
		check('SSR /content: Kit is NOT booted (csr=false)', !KIT_BOOT_RE.test(content));
	});

	// ── SSR: the csr=true world ───────────────────────────────────────────────────────────────
	test('SSR: the csr=true world', async () => {
		const spa = await (await fetch(base + '/spa')).text();
		check('SSR /spa: page rendered', SPA_PAGE_RE.test(spa));
		check('SSR /spa: Kit IS booted (csr=true)', KIT_BOOT_RE.test(spa));
	});

	// ── Browser: chrome hydrates on the csr=false page ────────────────────────────────────────
	for (const [route, label] of [
		['/content/hello', 'csr=false page (ogygia hydrates the chrome)'],
		['/spa', 'csr=true page (Kit hydrates the chrome inline)']
	] as const) {
		test(`browser: ${label}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			page.on('console', (m) => {
				if (m.type() === 'error') errors.push('console: ' + m.text());
			});
			await page.goto(base + route, { waitUntil: 'networkidle' });
			await page.waitForTimeout(300);

			const count = page.locator('[data-header-count]');
			check(`${label}: header seeded (0)`, (await count.innerText()) === '0');
			await count.click();
			await page.waitForTimeout(60);
			check(
				`${label}: header ALIVE (0 → 1)`,
				(await count.innerText()) === '1',
				`n=${await count.innerText()}`
			);
			check(
				`${label}: boot island effect ran`,
				(await page.evaluate(() => document.documentElement.dataset.boot)) === 'on'
			);
			check(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
		});
	}
});
