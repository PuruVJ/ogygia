// DEV recovery: a Vite dep re-optimization rotates the optimizer hash, so a tab loaded under the
// old hash dynamic-imports island deps that now 404 — every island fails on wake with
// `Failed to fetch dynamically imported module`, and under csr=false Kit's absent client can't
// receive Vite's full-reload. The runtime watchdog CONFIRMS it is staleness (the entry still serves
// on a plain fetch, only the `?import` transform 404s) and reloads the tab once, loop-guarded so a
// genuinely-broken entry never reloads forever.
//
// Simulated here by aborting the island's `?import` request (the dynamic import) while letting the
// plain module fetch (the watchdog's confirmation) succeed. Dev only — the prod build tree-shakes
// the watchdog out, so this must run against a real `vite dev` server.
//
//   pnpm exec playwright test dev-stale-dep-reload
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check, sleep } from './fixtures/index.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const playground = join(repo, 'apps', 'playground');
const PORT = 3089;
const base = `http://127.0.0.1:${PORT}`;

let srv: SpawnedServer | null = null;

test.describe('dev: a stale-dep entry-fetch failure recovers the tab', () => {
	test.beforeAll(async () => {
		srv = await spawn_server({
			cmd: 'pnpm',
			args: ['--dir', playground, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
			cwd: repo,
			url: `${base}/interaction`,
			timeout_ms: 120_000
		});
	});

	test.afterAll(() => srv?.kill());

	test('the watchdog reloads once when the entry serves but its import fails, then stops', async ({ page }) => {
		test.setTimeout(120_000);
		// Count loads across reloads.
		await page.addInitScript(() => {
			try {
				const n = Number(sessionStorage.getItem('__og_loads') || '0') + 1;
				sessionStorage.setItem('__og_loads', String(n));
			} catch {
				/* ignore */
			}
		});
		// The DYNAMIC IMPORT (`?import`) of an island 404s — the stale-hash symptom. The plain fetch
		// (the watchdog's confirm) is left alone, so the watchdog sees a live module and reloads.
		await page.route(/virtual:ogygia\/island\/[^?]*\.js\?import/, (r) => r.abort());

		await page.goto(`${base}/interaction`, { waitUntil: 'networkidle' });
		await page.locator('[data-i-btn]').click(); // wakes the interaction island → import fails
		// watchdog: confirm-fetch + one reload
		await sleep(4000);

		const loads = await page.evaluate(() => {
			try {
				return Number(sessionStorage.getItem('__og_loads') || '0');
			} catch {
				return -1;
			}
		});
		check('reloaded exactly once (recovered), did not loop', loads === 2, `loads=${loads}`);
	});
});
