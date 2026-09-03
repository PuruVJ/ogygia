// asRegion — `import.meta.og.asRegion(Comp, timing)` marks a NAMED / barrel import as a placed
// island (the macro alternative to `import X with { wake }`, which is default-import-only). Proves
// three things against the built playground /as-region page:
//   1. both barrel components SSR + hydrate (Ticker wake:'load', Flag wake:'visible'),
//   2. a NON-component barrel export (brandConfig) still works as an ordinary value in the shell,
//   3. TREE-SHAKING — the unused barrel exports (a heavy component + a huge constant) never reach the
//      client build, so an island off a huge barrel ships lean, not the whole barrel.
//
// Usage: pnpm exec playwright test as-region
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check, sleep } from './fixtures/index.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));

test.describe('import.meta.og.asRegion: barrel/named-import islands SSR+hydrate; unused barrel exports tree-shaken', () => {
	test.use({ viewport: { width: 1000, height: 900 } });

	// ── 1 + 2. browser: SSR + hydration + mixed barrel export ────────────────────────────────────────
	test('browser: SSR + hydration + mixed barrel export', async ({ page }) => {
		const errs: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'error') errs.push(m.text());
		});
		page.on('pageerror', (e) => errs.push(String(e)));
		await page.goto('/as-region', { waitUntil: 'networkidle' });

		// Ticker — wake:'load' → hydrates immediately.
		const ticker = page.locator('[data-ticker] button').first();
		await ticker.waitFor();
		check(
			'asRegion: ticker SSR prop (start=10)',
			(await ticker.textContent())!.includes('ticks 10')
		);
		await ticker.click();
		await ticker.click();
		check(
			'asRegion: ticker (wake:load) hydrated + interactive',
			(await ticker.textContent())!.includes('ticks 12'),
			(await ticker.textContent())!
		);

		// Flag — wake:'visible' → hydrates once scrolled into view.
		const flag = page.locator('[data-flag] button').first();
		await flag.waitFor();
		check('asRegion: flag SSR prop (on=true)', (await flag.textContent())!.includes('flag is ON'));
		await flag.scrollIntoViewIfNeeded();
		await sleep(300);
		await flag.click();
		check(
			'asRegion: flag (wake:visible) hydrated + interactive',
			(await flag.textContent())!.includes('flag is OFF'),
			(await flag.textContent())!
		);

		// A NON-component export from the SAME barrel, used as an ordinary value in the shell.
		check(
			'asRegion: non-component barrel export used in shell',
			(await page.locator('[data-brand]').textContent())!.includes('Acme Islands')
		);

		check('asRegion: no console errors', errs.length === 0, errs.join(' | '));
	});

	// ── 3. build-output: tree-shaking canaries must be ABSENT from the client build ────────────────────
	test('build-output: tree-shaking canaries must be ABSENT from the client build', () => {
		const clientDir = path.join(repo, 'apps/playground/.svelte-kit/output/client');
		function client_contains(marker: string): string[] {
			const hits: string[] = [];
			const walk = (d: string) => {
				let entries: fs.Dirent[];
				try {
					entries = fs.readdirSync(d, { withFileTypes: true });
				} catch {
					return;
				}
				for (const e of entries) {
					const f = path.join(d, e.name);
					if (e.isDirectory()) walk(f);
					else if (f.endsWith('.js') && fs.readFileSync(f, 'utf-8').includes(marker))
						hits.push(path.relative(clientDir, f));
				}
			};
			walk(clientDir);
			return hits;
		}
		if (fs.existsSync(clientDir)) {
			const hugeHits = client_contains('ogygia_barrel_huge_unused_canary');
			check(
				'asRegion: huge unused barrel constant tree-shaken (absent from client)',
				hugeHits.length === 0,
				hugeHits.join(', ')
			);
			const compHits = client_contains('ogygia_barrel_heavy_component_canary');
			check(
				'asRegion: unused barrel component tree-shaken (absent from client)',
				compHits.length === 0,
				compHits.join(', ')
			);
		} else {
			check(
				'asRegion: client build present for tree-shake inspection',
				false,
				`missing ${clientDir}`
			);
		}
	});
});
