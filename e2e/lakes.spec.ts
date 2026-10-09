// LAKES: a `wake: 'none'` component INSIDE a hydrated island is a frozen region. This suite
// proves the full alternation shell -> island -> lake -> island-in-lake, plus the two guarantees
// that make a lake a lake: its component code ships in NO client chunk, and its DOM is frozen
// (events inert) yet an island authored inside it self-hydrates. Also exercises remount:'cache'
// and remount:'swr' on {#if} toggle.
//
//   pnpm exec playwright test lakes   # a PRODUCTION build (preview/adapter output)
//
// The client-chunk-exclusion assertion reads the playground's client build output, so it only runs
// when that directory exists (a prod build); pass any base URL for the browser checks.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check, sleep } from './fixtures/index.ts';

const JS_FILE_RE = /\.(js|mjs)$/;
const ISLAND_COUNT_1_RE = /island count: 1/;
const INNER_COUNT_1_RE = /: 1/;
const FROZEN_BUTTON_0_RE = /frozen button: 0/;

// The distinctive string embedded in the lake component (FrozenBox). It must appear in the SERVER
// build (the lake SSRs inline) and in NO client chunk (its JS is swapped for a placeholder).
const MARKER = 'FROZEN_LAKE_CODE_MARKER_9f3a';
const repo = fileURLToPath(new URL('..', import.meta.url));
const client_dir = join(repo, 'apps/playground', '.svelte-kit', 'output', 'client');
const server_dir = join(repo, 'apps/playground', '.svelte-kit', 'output', 'server');

function grep_dir(dir: string): number {
	let hits = 0;
	const walk = (d: string) => {
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (JS_FILE_RE.test(e.name) && readFileSync(full, 'utf-8').includes(MARKER)) hits++;
		}
	};
	walk(dir);
	return hits;
}

const note = (text: string) => test.info().annotations.push({ type: 'note', description: text });

test.describe('frozen region, no client JS, island-in-lake, restore, remount cache/swr', () => {
	// --- build-output guarantee: the lake's code is excluded from every client chunk ---------------
	test("build output: the lake's code ships in NO client chunk, IS in the server build", () => {
		test.skip(
			!existsSync(client_dir),
			'client-chunk exclusion (no prod build output — run against a preview/prod build)'
		);
		const client_hits = grep_dir(client_dir);
		const server_hits = grep_dir(server_dir);
		check(
			'lake code ships in NO client chunk (frozen: its JS never reaches the browser)',
			client_hits === 0,
			`${client_hits} client chunk(s)`
		);
		check(
			'lake code IS in the server build (it SSRs inline)',
			server_hits >= 1,
			`${server_hits} server file(s)`
		);
	});

	test('/lakes: frozen region, island-in-lake, inert lake button, remount cache + swr', async ({
		page
	}) => {
		const remoteErrs: string[] = [];
		page.on('pageerror', (e) => remoteErrs.push(e.message));
		await page.goto('/lakes', { waitUntil: 'load' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 6000 }).catch(() => {});
		await sleep(1500);

		// SSR structure: frozen region (`wake="none"`) + remount attr (default cache).
		check(
			'frozen region emitted as <ogygia-region wake="none">',
			(await page.locator('ogygia-region[wake="none"]').count()) >= 1
		);
		check(
			'default remount is cache on hydrate=none',
			(await page.locator('ogygia-region[wake="none"][remount="cache"]').count()) >= 1
		);

		// Frozen content is present (SSR rendered inline, restored around parent hydration).
		check(
			'lake SSR content present after hydration (lifted + restored)',
			(await page.locator('[data-frozen-box]').count()) >= 1
		);

		// Outer island hydrated + interactive (first LakeCounter).
		const c0 = (await page.locator('[data-count-btn]').first().textContent()).trim();
		await page.locator('[data-count-btn]').first().click();
		const c1 = (await page.locator('[data-count-btn]').first().textContent()).trim();
		check(
			'outer island hydrates & is interactive',
			c0 !== c1 && ISLAND_COUNT_1_RE.test(c1),
			`${c0} -> ${c1}`
		);

		// Island-in-lake self-hydrates (the lake reset its subtree to dead — nearest-boundary rule).
		const i0 = (
			await page
				.locator('[data-inner-btn]')
				.first()
				.textContent()
				.catch(() => '')
		).trim();
		await page.locator('[data-inner-btn]').first().click();
		const i1 = (
			await page
				.locator('[data-inner-btn]')
				.first()
				.textContent()
				.catch(() => '')
		).trim();
		check(
			'island INSIDE the lake self-hydrates & works (alternation)',
			i0 !== i1 && INNER_COUNT_1_RE.test(i1),
			`${i0} -> ${i1}`
		);

		// The lake itself is FROZEN: its own button is inert (no JS shipped).
		const f0 = (await page.locator('[data-frozen-btn]').first().textContent()).trim();
		await page.locator('[data-frozen-btn]').first().click();
		await sleep(150);
		const f1 = (await page.locator('[data-frozen-btn]').first().textContent()).trim();
		check(
			'lake is frozen: its button is inert (no client JS, events do nothing)',
			f0 === f1 && FROZEN_BUTTON_0_RE.test(f1),
			`${f0} -> ${f1}`
		);

		// remount: 'cache' — {#if} toggle re-creates the region and the frozen DOM is re-inserted.
		const boxesBefore = await page.locator('[data-frozen-box]').count();
		await page.locator('[data-toggle-btn]').first().click();
		await sleep(250);
		const boxesHidden = await page.locator('[data-frozen-box]').count();
		await page.locator('[data-toggle-btn]').first().click();
		await sleep(400);
		const boxesRestored = await page.locator('[data-frozen-box]').count();
		check("remount 'cache': {#if}-toggle off removes a lake", boxesHidden < boxesBefore);
		check(
			"remount 'cache': {#if}-toggle on re-inserts the frozen DOM",
			boxesRestored === boxesBefore
		);
		check(
			"remount 'cache': inner island present after restore",
			(await page.locator('[data-inner-btn]').count()) >= 1
		);

		// remount: swr — second demo; toggle triggers a region endpoint fetch after paint.
		const swrRoot = page.locator('[data-swr-demo]');
		if ((await swrRoot.count()) === 1) {
			const fetches: string[] = [];
			page.on('request', (req) => {
				const u = req.url();
				if (u.includes('ogygia') || decodeURIComponent(u).includes('__ogygia__')) fetches.push(u);
			});
			const stampBefore = await swrRoot
				.locator('[data-frozen-stamp]')
				.first()
				.getAttribute('data-frozen-stamp')
				.catch(() => null);
			await swrRoot.locator('[data-toggle-btn]').click();
			await sleep(200);
			await swrRoot.locator('[data-toggle-btn]').click();
			await sleep(800);
			check(
				"remount 'swr': {#if}-toggle triggers region endpoint fetch",
				fetches.length >= 1,
				`${fetches.length} fetch(es)`
			);
			const revalidated = await swrRoot
				.locator('ogygia-region[wake="none"][data-revalidated]')
				.count();
			check(
				"remount 'swr': region marked data-revalidated after fetch",
				revalidated >= 1,
				`${revalidated}`
			);
			if (stampBefore != null) {
				const stampAfter = await swrRoot
					.locator('[data-frozen-stamp]')
					.first()
					.getAttribute('data-frozen-stamp');
				check(
					"remount 'swr': paints fresh SSR (stamp advances)",
					stampAfter != null && stampAfter !== stampBefore,
					`${stampBefore} -> ${stampAfter}`
				);
			} else {
				note('SKIP  remount swr stamp freshness (no data-frozen-stamp in build)');
			}
			check(
				"remount 'swr': inner island present after revalidate",
				(await swrRoot.locator('[data-inner-btn]').count()) >= 1
			);
		} else {
			note('SKIP  remount swr demo (no [data-swr-demo] on page)');
		}
	});

	// ── REGRESSION: two same-component lakes in one island keep their OWN content ──────────────────
	// lift/restore pairs lifted frozen DOM back by POSITION; a shared entry id must not funnel both
	// frags into the first box (which left the second empty before the fix).
	test('/two-lakes: two same-component lakes in one island keep their OWN content', async ({
		page
	}) => {
		await page.goto('/two-lakes', { waitUntil: 'load' });
		await sleep(300);
		const first = page.locator('[data-tlh-first] [data-frozen-box]');
		const second = page.locator('[data-tlh-second] [data-frozen-box]');
		check(
			'two lakes: both frozen boxes present',
			(await first.count()) === 1 && (await second.count()) === 1
		);
		const firstLabel = await page
			.locator('[data-tlh-first] [data-frozen-label]')
			.textContent()
			.catch(() => null);
		const secondLabel = await page
			.locator('[data-tlh-second] [data-frozen-label]')
			.textContent()
			.catch(() => null);
		check(
			'first lake kept its OWN content',
			firstLabel?.trim() === 'alpha-lake',
			`first=${firstLabel}`
		);
		check(
			"second lake kept its OWN content (not empty / not the first lake's)",
			secondLabel?.trim() === 'beta-lake',
			`second=${secondLabel}`
		);
	});
});
