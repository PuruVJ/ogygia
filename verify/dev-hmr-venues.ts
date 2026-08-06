/**
 * Dev HMR venue audit under csr=false (docs app).
 *
 *   node verify/dev-hmr-venues.ts http://127.0.0.1:5174
 *
 * Mutates markers, waits for DOM, restores files. Exit 0 only if all venues pass.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:5174';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');

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

const results = [];

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function withBackup(file, mutator) {
	const orig = fs.readFileSync(file, 'utf8');
	try {
		fs.writeFileSync(file, mutator(orig));
		return () => fs.writeFileSync(file, orig);
	} catch (e) {
		fs.writeFileSync(file, orig);
		throw e;
	}
}

async function htmlIncludes(page, needle) {
	try {
		return (await page.content()).includes(needle);
	} catch {
		// full-reload mid-read — treat as not-yet
		return false;
	}
}

async function waitFor(page, pred, label, timeoutMs = 12000) {
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

async function runVenue(name, fn) {
	try {
		await fn();
		results.push({ name, ok: true });
		console.log(`PASS  ${name}`);
	} catch (e) {
		results.push({ name, ok: false, err: String(e?.message || e) });
		console.log(`FAIL  ${name}  — ${e?.message || e}`);
	}
}

const browser = await chromium.launch({
	headless: true,
	executablePath:
		process.env.PLAYWRIGHT_CHROME ||
		'/Users/puruvj/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
});
const page = await browser.newPage();

try {
	await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30000 });
	await sleep(1500);

	const bridge = await page.evaluate(() => ({
		hmrScript: !!document.querySelector('script[data-ogygia-dev-hmr]'),
		viteClient: performance.getEntriesByType('resource').some((r) => r.name.includes('@vite/client'))
	}));
	console.log('bridge', bridge);
	if (!bridge.hmrScript && !bridge.viteClient) {
		console.log('WARN  no dev-hmr bridge / @vite/client — full-reload + soft CSS may fail');
	}

	// --- +page.svelte route shell ---
	await runVenue('+page.svelte shell full-reload', async () => {
		const restore = withBackup(PAGE, (s) => {
			if (!s.includes('SSR islands for SvelteKit')) throw new Error('anchor text missing');
			return s.replace(
				'SSR islands for SvelteKit',
				`SSR islands for SvelteKit ${MARK_A}`
			);
		});
		try {
			await waitFor(page, async () => htmlIncludes(page, MARK_A), 'page marker A');
			const restore2 = withBackup(PAGE, (s) => s.replace(MARK_A, MARK_B));
			try {
				await waitFor(page, async () => htmlIncludes(page, MARK_B), 'page marker B');
			} finally {
				restore2();
			}
			await waitFor(
				page,
				async () =>
					!(await htmlIncludes(page, MARK_B)) &&
					(await htmlIncludes(page, 'SSR islands for SvelteKit')),
				'page restored'
			);
		} finally {
			restore();
		}
	});

	// --- +layout.svelte route shell ---
	await runVenue('+layout.svelte shell full-reload', async () => {
		const restore = withBackup(LAYOUT, (s) => {
			if (!s.includes('<OgygiaRouter />')) throw new Error('layout anchor missing');
			return s.replace(
				'<OgygiaRouter />',
				`<OgygiaRouter />\n<span data-hmr-layout="${MARK_A}" hidden>${MARK_A}</span>`
			);
		});
		try {
			await waitFor(
				page,
				async () =>
					(await page.locator(`[data-hmr-layout="${MARK_A}"]`).count()) > 0 ||
					(await htmlIncludes(page, MARK_A)),
				'layout marker A'
			);
		} finally {
			restore();
		}
		await waitFor(
			page,
			async () => (await page.locator('[data-hmr-layout]').count()) === 0,
			'layout restored'
		);
	});

	// --- Island entry: SideNav.svelte ---
	await runVenue('SideNav.svelte island entry', async () => {
		const restore = withBackup(SIDENAV, (s) => {
			if (!s.includes('<span>Docs</span>')) throw new Error('SideNav Docs label missing');
			return s.replace('<span>Docs</span>', `<span data-hmr-nav="${MARK_A}">Docs ${MARK_A}</span>`);
		});
		try {
			await waitFor(
				page,
				async () => (await page.locator(`[data-hmr-nav="${MARK_A}"]`).count()) > 0,
				'nav marker A'
			);
			const restore2 = withBackup(SIDENAV, (s) =>
				s.replace(`Docs ${MARK_A}`, `Docs ${MARK_B}`).replace(
					`data-hmr-nav="${MARK_A}"`,
					`data-hmr-nav="${MARK_B}"`
				)
			);
			try {
				await waitFor(
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
		await waitFor(
			page,
			async () => (await page.locator('[data-hmr-nav]').count()) === 0,
			'nav restored'
		);
	});

	// --- Shared module: toc-items.ts ---
	await runVenue('toc-items.ts shared module', async () => {
		const restore = withBackup(TOC, (s) => {
			if (!s.includes(`label: '${TOC_A}'`)) throw new Error('Features toc label missing');
			return s.replace(`label: '${TOC_A}'`, `label: '${TOC_B}'`);
		});
		try {
			await waitFor(
				page,
				async () => (await page.locator(`text=${TOC_B}`).count()) > 0,
				'toc label B'
			);
		} finally {
			restore();
		}
		await waitFor(
			page,
			async () =>
				(await page.locator(`text=${TOC_B}`).count()) === 0 &&
				(await page.locator(`text=${TOC_A}`).first().count()) > 0,
			'toc restored'
		);
	});

	// --- CSS soft HMR regression ---
	await runVenue('app.css soft HMR', async () => {
		const restore = withBackup(CSS, (s) => {
			if (s.includes(CSS_A) || s.includes('HMR_CSS_B')) {
				// already patched somehow
			}
			return CSS_B + s;
		});
		try {
			await waitFor(
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
		await waitFor(
			page,
			async () =>
				(await page.evaluate(() =>
					getComputedStyle(document.documentElement).getPropertyValue('--hmr-probe').trim()
				)) === '',
			'css restored'
		);
	});
} finally {
	await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n---');
console.log(`${results.length - failed.length}/${results.length} venues passed`);
if (failed.length) {
	for (const f of failed) console.log(`  ${f.name}: ${f.err}`);
	process.exit(1);
}
process.exit(0);
