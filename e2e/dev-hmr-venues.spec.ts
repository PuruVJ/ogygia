/**
 * Dev HMR venue audit under csr=false (docs app).
 *
 *   pnpm exec playwright test dev-hmr-venues
 *
 * Mutates markers, waits for DOM, restores files. Exit 0 only if all venues pass.
 * Self-booting: the docs app's `vite dev` (port 5174, the script's default base) comes up in
 * `beforeAll` and is torn down after.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, check, sleep } from './fixtures/index.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'apps/docs');
const PORT = 5174;
const base = `http://127.0.0.1:${PORT}`;

const PAGE = path.join(docs, 'src/routes/+page.svelte');
const LAYOUT = path.join(docs, 'src/routes/+layout.svelte');
const SIDENAV = path.join(docs, 'src/lib/SideNav.svelte');
const TOC = path.join(docs, 'src/lib/toc-items.ts');
const CSS = path.join(docs, 'src/app.css');

const MARK_A = 'HMR_VENUE_MARK_A';
const MARK_B = 'HMR_VENUE_MARK_B';
const TOC_A = 'Features';
const TOC_B = 'HMRFeaturesX';
const CSS_A = '/* HMR_CSS_A */';
const CSS_B = '/* HMR_CSS_B */\nhtml { --hmr-probe: 1; }\n';

function with_backup(file: string, mutator: (s: string) => string) {
	const orig = fs.readFileSync(file, 'utf8');
	try {
		fs.writeFileSync(file, mutator(orig));
		return () => fs.writeFileSync(file, orig);
	} catch (e) {
		fs.writeFileSync(file, orig);
		throw e;
	}
}

async function html_includes(page: Page, needle: string) {
	try {
		return (await page.content()).includes(needle);
	} catch {
		// full-reload mid-read — treat as not-yet
		return false;
	}
}

async function wait_for(
	page: Page,
	pred: () => Promise<boolean>,
	label: string,
	timeoutMs = 12000
) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			if (await pred()) return true;
		} catch {
			/* navigating */
		}
		await sleep(200);
	}
	throw new Error(`timeout waiting for ${label}`);
}

/** A venue is one soft check: it passes when its body settles, fails with the thrown reason. */
async function run_venue(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		check(name, true);
	} catch (e) {
		check(name, false, String((e as Error)?.message || e));
	}
}

let srv: SpawnedServer | undefined;

test.describe('dev HMR venues under csr=false (docs app): page/layout shell full-reload, island entry, shared module, soft CSS (self-booting docs dev server)', () => {
	// STALE: the source script (an orphan — never in the run.ts roster, so it never ran in CI)
	// pins docs-app files that the content/site-kit rework removed — `src/routes/+page.svelte`,
	// `src/lib/SideNav.svelte`, `src/lib/toc-items.ts`, and `<OgygiaRouter />` in the layout. Four
	// of the five venues can no longer find their anchor. Skipped, not deleted, so the HMR-venue
	// intent survives for a fixture that pins its own files instead of the moving docs app.
	test.skip(
		true,
		'stale docs-app anchors after the content/site-kit rework — needs a self-owned fixture'
	);

	test.beforeAll(async () => {
		test.setTimeout(15 * 60_000);
		srv = await spawn_server({
			cmd: 'pnpm',
			args: [
				'--filter',
				'docs',
				'exec',
				'vite',
				'dev',
				'--port',
				String(PORT),
				'--host',
				'127.0.0.1'
			],
			cwd: root,
			url: base + '/',
			timeout_ms: 120_000
		});
	});
	test.afterAll(() => srv?.kill());

	// One page for every venue: HMR full-reloads it in place, so the venues share it as the script did.
	test('five venues: +page.svelte, +layout.svelte, SideNav.svelte, toc-items.ts, app.css', async ({
		page
	}) => {
		await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
		await sleep(1500);

		const bridge = await page.evaluate(() => ({
			hmrScript: !!document.querySelector('script[data-ogygia-dev-hmr]'),
			viteClient: performance
				.getEntriesByType('resource')
				.some((r) => r.name.includes('@vite/client'))
		}));
		console.log('bridge', bridge);
		if (!bridge.hmrScript && !bridge.viteClient) {
			console.log('WARN  no dev-hmr bridge / @vite/client — full-reload + soft CSS may fail');
		}

		// --- +page.svelte route shell ---
		await run_venue('+page.svelte shell full-reload', async () => {
			const restore = with_backup(PAGE, (s) => {
				if (!s.includes('SSR islands for SvelteKit')) throw new Error('anchor text missing');
				return s.replace('SSR islands for SvelteKit', `SSR islands for SvelteKit ${MARK_A}`);
			});
			try {
				await wait_for(page, async () => html_includes(page, MARK_A), 'page marker A');
				const restore2 = with_backup(PAGE, (s) => s.replace(MARK_A, MARK_B));
				try {
					await wait_for(page, async () => html_includes(page, MARK_B), 'page marker B');
				} finally {
					restore2();
				}
				await wait_for(
					page,
					async () =>
						!(await html_includes(page, MARK_B)) &&
						(await html_includes(page, 'SSR islands for SvelteKit')),
					'page restored'
				);
			} finally {
				restore();
			}
		});

		// --- +layout.svelte route shell ---
		await run_venue('+layout.svelte shell full-reload', async () => {
			const restore = with_backup(LAYOUT, (s) => {
				if (!s.includes('<OgygiaRouter />')) throw new Error('layout anchor missing');
				return s.replace(
					'<OgygiaRouter />',
					`<OgygiaRouter />\n<span data-hmr-layout="${MARK_A}" hidden>${MARK_A}</span>`
				);
			});
			try {
				await wait_for(
					page,
					async () =>
						(await page.locator(`[data-hmr-layout="${MARK_A}"]`).count()) > 0 ||
						(await html_includes(page, MARK_A)),
					'layout marker A'
				);
			} finally {
				restore();
			}
			await wait_for(
				page,
				async () => (await page.locator('[data-hmr-layout]').count()) === 0,
				'layout restored'
			);
		});

		// --- Island entry: SideNav.svelte ---
		await run_venue('SideNav.svelte island entry', async () => {
			const restore = with_backup(SIDENAV, (s) => {
				if (!s.includes('<span>Docs</span>')) throw new Error('SideNav Docs label missing');
				return s.replace(
					'<span>Docs</span>',
					`<span data-hmr-nav="${MARK_A}">Docs ${MARK_A}</span>`
				);
			});
			try {
				await wait_for(
					page,
					async () => (await page.locator(`[data-hmr-nav="${MARK_A}"]`).count()) > 0,
					'nav marker A'
				);
				const restore2 = with_backup(SIDENAV, (s) =>
					s
						.replace(`Docs ${MARK_A}`, `Docs ${MARK_B}`)
						.replace(`data-hmr-nav="${MARK_A}"`, `data-hmr-nav="${MARK_B}"`)
				);
				try {
					await wait_for(
						page,
						async () => (await page.locator(`[data-hmr-nav="${MARK_B}"]`).count()) > 0,
						'nav marker B'
					);
				} finally {
					restore2();
				}
			} finally {
				restore();
			}
			await wait_for(
				page,
				async () => (await page.locator('[data-hmr-nav]').count()) === 0,
				'nav restored'
			);
		});

		// --- Shared module: toc-items.ts ---
		await run_venue('toc-items.ts shared module', async () => {
			const restore = with_backup(TOC, (s) => {
				if (!s.includes(`label: '${TOC_A}'`)) throw new Error('Features toc label missing');
				return s.replace(`label: '${TOC_A}'`, `label: '${TOC_B}'`);
			});
			try {
				await wait_for(
					page,
					async () => (await page.locator(`text=${TOC_B}`).count()) > 0,
					'toc label B'
				);
			} finally {
				restore();
			}
			await wait_for(
				page,
				async () =>
					(await page.locator(`text=${TOC_B}`).count()) === 0 &&
					(await page.locator(`text=${TOC_A}`).first().count()) > 0,
				'toc restored'
			);
		});

		// --- CSS soft HMR regression ---
		await run_venue('app.css soft HMR', async () => {
			const restore = with_backup(CSS, (s) => {
				if (s.includes(CSS_A) || s.includes('HMR_CSS_B')) {
					// already patched somehow
				}
				return CSS_B + s;
			});
			try {
				await wait_for(
					page,
					async () =>
						(await page.evaluate(() =>
							getComputedStyle(document.documentElement).getPropertyValue('--hmr-probe').trim()
						)) === '1',
					'css --hmr-probe'
				);
			} finally {
				restore();
			}
			await wait_for(
				page,
				async () =>
					(await page.evaluate(() =>
						getComputedStyle(document.documentElement).getPropertyValue('--hmr-probe').trim()
					)) === '',
				'css restored'
			);
		});
	});
});
