// wake:'interaction' — the island ships no JS until a pointer/key/focus lands inside it; the
// first click is canceled + replayed after hydration (counts exactly once, isTrusted=false);
// typing before hydration survives (value restored, bind synced); hover warms the chunk without
// hydrating; hydratedBy() reports 'interaction'.
// Usage: node verify/interaction.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// ---------- SSR ----------
const raw = await (await fetch(base + '/interaction')).text();
check('SSR: region carries wake="interaction"', /ogygia-region[^>]*wake="interaction"/.test(raw));
const interactionEntry = raw.match(/ogygia-region entry="([^"]+)"[^>]*wake="interaction"/)?.[1] ?? '';
check('SSR: interaction region has an entry chunk', interactionEntry.length > 0, interactionEntry);

const browser = await chromium.launch();
try {
	// ---------- cold: bytes ride background hints, but NOTHING executes ----------
	{
		const page = await browser.newPage();
		const fetched: string[] = [];
		page.on('request', (r) => fetched.push(r.url()));
		await page.goto(base + '/interaction', { waitUntil: 'networkidle' });
		await page.waitForTimeout(300);
		const entryFile = interactionEntry.split('/').pop() ?? '@@none@@';
		// New contract: an interaction island's BYTES prefetch at load via an SSR-emitted
		// `fetchpriority="low"` modulepreload hint (background priority — never contends with
		// critical work); evaluation still waits for the gesture. The chunk is therefore fetched
		// at load — hint-initiated, not island-initiated — and the region stays cold.
		const hint = await page
			.locator(`link[rel="modulepreload"][fetchpriority="low"][href*="${entryFile}"]`)
			.count();
		check('cold: low-priority modulepreload hint for the interaction chunk', hint === 1);
		check('cold: chunk prefetched in the background', fetched.some((u) => u.includes(entryFile)), entryFile);
		check('cold: region not hydrated', (await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 0);
		// eager load island on the same page DID hydrate (islands generally work here)
		check('cold: eager island on same page hydrated', (await page.locator('ogygia-region[wake="load"][data-hydrated]').count()) === 1);

		// ---------- hover pre-evaluates (cache hit) without hydrating ----------
		await page.locator('[data-interaction-counter]').hover();
		await page.waitForTimeout(250);
		check('hover: still not hydrated', (await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 0);

		// ---------- first click wakes + replays (counts exactly once) ----------
		await page.locator('[data-i-btn]').click();
		await page.waitForTimeout(300);
		check('click: island hydrated', (await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 1);
		check('click: FIRST click counted (replay, exactly once)', (await page.locator('[data-i-count]').innerText()) === '1', `count=${await page.locator('[data-i-count]').innerText()}`);
		check('click: replayed event is untrusted (documented semantics)', (await page.locator('[data-i-trusted]').innerText()) === 'false');
		check('click: hydratedBy() === interaction', (await page.locator('[data-interaction-counter]').getAttribute('data-woke')) === 'interaction');

		// second click is live + trusted
		await page.locator('[data-i-btn]').click();
		await page.waitForTimeout(50);
		check('second click: live island counts (2)', (await page.locator('[data-i-count]').innerText()) === '2');
		check('second click: trusted (real handler now)', (await page.locator('[data-i-trusted]').innerText()) === 'true');
		await page.close();
	}

	// ---------- interaction × crossed children (composed island on the interaction schedule) ----------
	{
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto(base + '/interaction', { waitUntil: 'networkidle' });
		await page.waitForTimeout(200);

		const card = page.locator('[data-ix-card]');
		check('children: crossed child SSR-rendered, island cold', (await card.locator('[data-ix-child]').innerText()) === 'crossed child inside an interaction island');
		check('children: card region not hydrated before use', (await card.locator('ogygia-region[data-hydrated]').count()) === 0);

		// First click on the toggle: wakes the synthesized-children entry, replays EXACTLY once —
		// initial open=true, so exactly one activation flips it shut and hides the crossed child.
		await card.locator('[data-card-toggle]').click();
		await page.waitForTimeout(300);
		check('children: click hydrated the composed island', (await card.locator('ogygia-region[data-hydrated]').count()) === 1);
		check('children: waking toggle applied exactly once (open → shut)', /shut/.test((await card.locator('[data-card-toggle]').innerText()) || ''), await card.locator('[data-card-toggle]').innerText());
		check('children: crossed child hidden by the replayed toggle', (await card.locator('[data-ix-child]').count()) === 0);

		// Live now: second click restores the crossed child.
		await card.locator('[data-card-toggle]').click();
		await page.waitForTimeout(50);
		check('children: live toggle restores crossed child', (await card.locator('[data-ix-child]').count()) === 1);
		check('children: no page errors', errors.length === 0, errors.join(' | '));
		await page.close();
	}

	// ---------- hydration FAILURE disarms (clicks stop being eaten, error logged) ----------
	{
		const page = await browser.newPage();
		const consoleErrs: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'error') consoleErrs.push(m.text());
		});
		// Block the island chunk → the wake's import fails.
		const entryFile = interactionEntry.split('/').pop() ?? '@@none@@';
		await page.route(`**/${entryFile}`, (r) => r.abort());
		await page.goto(base + '/interaction', { waitUntil: 'networkidle' });
		await page.locator('[data-i-btn]').click();
		await page.waitForTimeout(400);
		check('failure: island stays unhydrated (no crash)', (await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 0);
		// #hydrate catches internally ("hydration failed for") and resolves → the wake path disarms
		// on the fulfilled branch; the rejection branch ("failed to hydrate") is defense-in-depth.
		check('failure: error logged, region left static', consoleErrs.some((t) => t.includes('hydration failed') || t.includes('failed to hydrate')));
		// The page survives — the eager island is still live.
		await page.locator('[data-counter] button').click();
		check('failure: rest of the page still works', /count is 1/.test((await page.locator('[data-counter]').textContent()) || ''));
		await page.close();
	}

	// ---------- typing wakes it and the text survives hydration ----------
	{
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto(base + '/interaction', { waitUntil: 'networkidle' });
		// type immediately — keydown wakes it; characters land natively while it hydrates
		await page.locator('[data-i-input]').pressSequentially('hello', { delay: 15 });
		await page.waitForTimeout(400);
		check('typing: island hydrated by keystrokes', (await page.locator('ogygia-region[wake="interaction"][data-hydrated]').count()) === 1);
		check('typing: input value survived hydration', (await page.locator('[data-i-input]').inputValue()) === 'hello', `value=${await page.locator('[data-i-input]').inputValue()}`);
		check('typing: bind:value synced after restore', (await page.locator('[data-i-typed]').innerText()) === 'hello', `bound=${await page.locator('[data-i-typed]').innerText()}`);
		check('typing: focus stayed in the input', await page.locator('[data-i-input]').evaluate((el) => el === document.activeElement));
		check('typing: no page errors', errors.length === 0, errors.join(' | '));
		await page.close();
	}
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL INTERACTION CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
