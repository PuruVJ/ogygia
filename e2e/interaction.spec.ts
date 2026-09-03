// wake:'interaction' — the island ships no JS until a pointer/key/focus lands inside it; the
// first click is canceled + replayed after hydration (counts exactly once, isTrusted=false);
// typing before hydration survives (value restored, bind synced); hover warms the chunk without
// hydrating; hydratedBy() reports 'interaction'.
// Usage: pnpm exec playwright test interaction
import { test, check } from './fixtures/index.ts';

const WAKE_INTERACTION_RE = /ogygia-region[^>]*wake="interaction"/;
const INTERACTION_ENTRY_RE = /ogygia-region entry="([^"]+)"[^>]*wake="interaction"/;
const SHUT_RE = /shut/;
const COUNT_IS_1_RE = /count is 1/;

test.describe("wake:'interaction' — cold until used, click replay, typing survives", () => {
	// The SSR probe feeds every browser section (the entry chunk's file name), so it runs once up
	// front; `baseURL` is test-scoped, so the hook reads it off the project options.
	let raw = '';
	let interaction_entry = '';
	test.beforeAll(async ({}, testInfo) => {
		raw = await (await fetch(testInfo.project.use.baseURL + '/interaction')).text();
		interaction_entry = raw.match(INTERACTION_ENTRY_RE)?.[1] ?? '';
	});

	// ---------- SSR ----------
	test('SSR: the region carries wake="interaction" + an entry chunk', async () => {
		check('SSR: region carries wake="interaction"', WAKE_INTERACTION_RE.test(raw));
		check(
			'SSR: interaction region has an entry chunk',
			interaction_entry.length > 0,
			interaction_entry
		);
	});

	// ---------- cold: bytes ride background hints, but NOTHING executes ----------
	test('cold → hover → first click replays exactly once → second click live', async ({ page }) => {
		const fetched: string[] = [];
		page.on('request', (r) => fetched.push(r.url()));
		await page.goto('/interaction', { waitUntil: 'networkidle' });
		await page.waitForTimeout(300);
		const entryFile = interaction_entry.split('/').pop() ?? '@@none@@';
		// New contract: an interaction island's BYTES prefetch at load via an SSR-emitted
		// `fetchpriority="low"` modulepreload hint (background priority — never contends with
		// critical work); evaluation still waits for the gesture. The chunk is therefore fetched
		// at load — hint-initiated, not island-initiated — and the region stays cold.
		const hint = await page
			.locator(`link[rel="modulepreload"][fetchpriority="low"][href*="${entryFile}"]`)
			.count();
		check('cold: low-priority modulepreload hint for the interaction chunk', hint === 1);
		check(
			'cold: chunk prefetched in the background',
			fetched.some((u) => u.includes(entryFile)),
			entryFile
		);
		check(
			'cold: region not hydrated',
			(await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 0
		);
		// eager load island on the same page DID hydrate (islands generally work here)
		check(
			'cold: eager island on same page hydrated',
			(await page.locator('ogygia-region[wake="load"][data-hydrated]').count()) === 1
		);

		// ---------- hover pre-evaluates (cache hit) without hydrating ----------
		await page.locator('[data-interaction-counter]').hover();
		await page.waitForTimeout(250);
		check(
			'hover: still not hydrated',
			(await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 0
		);

		// ---------- first click wakes + replays (counts exactly once) ----------
		await page.locator('[data-i-btn]').click();
		await page.waitForTimeout(300);
		check(
			'click: island hydrated',
			(await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 1
		);
		check(
			'click: FIRST click counted (replay, exactly once)',
			(await page.locator('[data-i-count]').innerText()) === '1',
			`count=${await page.locator('[data-i-count]').innerText()}`
		);
		check(
			'click: replayed event is untrusted (documented semantics)',
			(await page.locator('[data-i-trusted]').innerText()) === 'false'
		);
		check(
			'click: hydratedBy() === interaction',
			(await page.locator('[data-interaction-counter]').getAttribute('data-woke')) === 'interaction'
		);

		// second click is live + trusted
		await page.locator('[data-i-btn]').click();
		await page.waitForTimeout(50);
		check(
			'second click: live island counts (2)',
			(await page.locator('[data-i-count]').innerText()) === '2'
		);
		check(
			'second click: trusted (real handler now)',
			(await page.locator('[data-i-trusted]').innerText()) === 'true'
		);
	});

	// ---------- interaction × crossed children (composed island on the interaction schedule) ----------
	test('interaction × crossed children: the composed island wakes on the toggle, replays once', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/interaction', { waitUntil: 'networkidle' });
		await page.waitForTimeout(200);

		const card = page.locator('[data-ix-card]');
		check(
			'children: crossed child SSR-rendered, island cold',
			(await card.locator('[data-ix-child]').innerText()) ===
				'crossed child inside an interaction island'
		);
		check(
			'children: card region not hydrated before use',
			(await card.locator('ogygia-region[data-hydrated]').count()) === 0
		);

		// First click on the toggle: wakes the synthesized-children entry, replays EXACTLY once —
		// initial open=true, so exactly one activation flips it shut and hides the crossed child.
		await card.locator('[data-card-toggle]').click();
		await page.waitForTimeout(300);
		check(
			'children: click hydrated the composed island',
			(await card.locator('ogygia-region[data-hydrated]').count()) === 1
		);
		check(
			'children: waking toggle applied exactly once (open → shut)',
			SHUT_RE.test((await card.locator('[data-card-toggle]').innerText()) || ''),
			await card.locator('[data-card-toggle]').innerText()
		);
		check(
			'children: crossed child hidden by the replayed toggle',
			(await card.locator('[data-ix-child]').count()) === 0
		);

		// Live now: second click restores the crossed child.
		await card.locator('[data-card-toggle]').click();
		await page.waitForTimeout(50);
		check(
			'children: live toggle restores crossed child',
			(await card.locator('[data-ix-child]').count()) === 1
		);
		check('children: no page errors', errors.length === 0, errors.join(' | '));
	});

	// ---------- hydration FAILURE disarms (clicks stop being eaten, error logged) ----------
	test('hydration failure disarms: no crash, error logged, rest of the page still works', async ({
		page
	}) => {
		const consoleErrs: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'error') consoleErrs.push(m.text());
		});
		// Block the island chunk → the wake's import fails.
		const entryFile = interaction_entry.split('/').pop() ?? '@@none@@';
		await page.route(`**/${entryFile}`, (r) => r.abort());
		await page.goto('/interaction', { waitUntil: 'networkidle' });
		await page.locator('[data-i-btn]').click();
		await page.waitForTimeout(400);
		check(
			'failure: island stays unhydrated (no crash)',
			(await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 0
		);
		// #hydrate catches internally ("hydration failed for") and resolves → the wake path disarms
		// on the fulfilled branch; the rejection branch ("failed to hydrate") is defense-in-depth.
		check(
			'failure: error logged, region left static',
			consoleErrs.some((t) => t.includes('hydration failed') || t.includes('failed to hydrate'))
		);
		// The page survives — the eager island is still live.
		await page.locator('[data-counter] button').click();
		check(
			'failure: rest of the page still works',
			COUNT_IS_1_RE.test((await page.locator('[data-counter]').textContent()) || '')
		);
	});

	// ---------- typing wakes it and the text survives hydration ----------
	test('typing wakes it and the text survives hydration', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/interaction', { waitUntil: 'networkidle' });
		// type immediately — keydown wakes it; characters land natively while it hydrates
		await page.locator('[data-i-input]').pressSequentially('hello', { delay: 15 });
		await page.waitForTimeout(400);
		check(
			'typing: island hydrated by keystrokes',
			(await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 1
		);
		check(
			'typing: input value survived hydration',
			(await page.locator('[data-i-input]').inputValue()) === 'hello',
			`value=${await page.locator('[data-i-input]').inputValue()}`
		);
		check(
			'typing: bind:value synced after restore',
			(await page.locator('[data-i-typed]').innerText()) === 'hello',
			`bound=${await page.locator('[data-i-typed]').innerText()}`
		);
		check(
			'typing: focus stayed in the input',
			await page.locator('[data-i-input]').evaluate((el) => el === document.activeElement)
		);
		check('typing: no page errors', errors.length === 0, errors.join(' | '));
	});
});
