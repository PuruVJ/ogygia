// Continuity — a NAMED transportable (`static [ogygia.wire] = { id, merge }`) is a SESSION-lifetime
// singleton in the Keep. Across an SPA navigation the visitor keeps the SAME live cart (identity +
// user edits survive), while each page's fresh server snapshot is reconciled via merge(). Tab-
// scoped: the server never remembers, a fresh tab starts empty.
// Usage: node verify/continuity.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));

	await page.goto(base + '/cart-a', { waitUntil: 'networkidle' });
	await page.waitForTimeout(150);
	check('A: cart starts empty', (await page.locator('[data-sc-count]').innerText()) === '0');
	const stampA = await page.locator('[data-sc-stamp]').innerText();

	// PERSISTENT ISLAND: tag the live player node + let it tick, so we can prove the SAME app
	// survives navigation (relocated, not remounted).
	await page.locator('[data-persist-player]').evaluate((el) => ((el as unknown as { __ogTag: number }).__ogTag = 12345));
	await page.waitForTimeout(400);
	const ticksBeforeNav = Number(await page.locator('[data-pp-ticks]').innerText());
	check('player: ticking before nav', ticksBeforeNav > 0, `ticks=${ticksBeforeNav}`);
	check('player: track is /cart-a before nav', (await page.locator('[data-pp-track]').innerText()) === '/cart-a');

	// user adds two items on page A
	await page.locator('[data-sc-add]').click();
	await page.locator('[data-sc-add]').click();
	await page.waitForTimeout(50);
	check('A: user added two items', (await page.locator('[data-sc-count]').innerText()) === '2');
	check('A: last item is from page a', (await page.locator('[data-sc-last]').innerText()) === 'a-2');

	// SPA nav → page B: server mints a FRESH cart, but the named codec reunites the client with the
	// live session cart. Items survive; the server stamp advances and merges in.
	await page.locator('[data-to-b]').click();
	await page.waitForTimeout(250);
	check('B: navigated (widget shows page b)', (await page.locator('[data-sc-page]').innerText()) === 'b');

	// The persisted player is the SAME live node (our tag survived) and never reset its ticks.
	check('player: SAME live node across nav (tag survived)', (await page.locator('[data-persist-player]').evaluate((el) => (el as unknown as { __ogTag?: number }).__ogTag)) === 12345);
	const ticksAfterNav = Number(await page.locator('[data-pp-ticks]').innerText());
	check('player: kept playing through nav (ticks did not reset)', ticksAfterNav >= ticksBeforeNav, `before=${ticksBeforeNav} after=${ticksAfterNav}`);
	// PROP-PUSH: the relocated live player took page B's track (not frozen at page A's first-mount).
	check('player: prop-push updated track to new route (/cart-b)', (await page.locator('[data-pp-track]').innerText()) === '/cart-b', `track=${await page.locator('[data-pp-track]').innerText()}`);
	check('B: cart items SURVIVED navigation (2)', (await page.locator('[data-sc-count]').innerText()) === '2', `count=${await page.locator('[data-sc-count]').innerText()}`);
	check('B: last user item survived (a-2)', (await page.locator('[data-sc-last]').innerText()) === 'a-2');
	const stampB = await page.locator('[data-sc-stamp]').innerText();
	check('B: server stamp advanced + merged in (fresh render)', stampB !== stampA && Number(stampB) > Number(stampA), `A=${stampA} B=${stampB}`);

	// live instance is the same: an add on B continues the same cart
	await page.locator('[data-sc-add]').click();
	await page.waitForTimeout(50);
	check('B: same live cart — add continues it (3)', (await page.locator('[data-sc-count]').innerText()) === '3');
	check('B: last item now from page b', (await page.locator('[data-sc-last]').innerText()) === 'b-1');

	// back to A → still the same live cart (3 items), stamp advances again
	await page.locator('[data-to-a]').click();
	await page.waitForTimeout(250);
	check('A again: cart still has 3 items (continuity round-trip)', (await page.locator('[data-sc-count]').innerText()) === '3', `count=${await page.locator('[data-sc-count]').innerText()}`);

	check('no page errors / hydration mismatch', errors.length === 0, errors.join(' | '));

	// ---------- ambient form-field survival across navigation ----------
	await page.goto(base + '/formkeep', { waitUntil: 'networkidle' });
	await page.waitForTimeout(150);
	await page.locator('[data-kf-name]').fill('Ada Lovelace');
	await page.locator('[data-kf-sub]').check();
	await page.locator('[data-kf-otp]').fill('999111'); // opted out with data-ogygia-no-keep
	await page.waitForTimeout(50);
	check('form: typed + checked, bind echoes', (await page.locator('[data-kf-echo]').innerText()) === 'Ada Lovelace ✓');

	// leave the page, then come back — the half-filled form must be restored
	await page.locator('[data-leave]').click();
	await page.waitForTimeout(200);
	check('form: navigated away', (await page.locator('[data-keep-form]').count()) === 0);
	await page.goBack();
	await page.waitForTimeout(300);
	check('form: back on the page', (await page.locator('[data-keep-form]').count()) === 1);
	check('form: text field restored', (await page.locator('[data-kf-name]').inputValue()) === 'Ada Lovelace', `value=${await page.locator('[data-kf-name]').inputValue()}`);
	check('form: checkbox restored', await page.locator('[data-kf-sub]').isChecked());
	check('form: bind resynced after restore (echo)', (await page.locator('[data-kf-echo]').innerText()) === 'Ada Lovelace ✓', `echo=${await page.locator('[data-kf-echo]').innerText()}`);
	check('form: data-ogygia-no-keep field NOT restored (starts blank)', (await page.locator('[data-kf-otp]').inputValue()) === '', `otp=${await page.locator('[data-kf-otp]').inputValue()}`);

	// ---------- speculation rules: NEVER in SPA mode ----------
	// Speculation caches serve real navigations only — a body-swap router can't read them, so with
	// the router ON ogygia must emit no rules (its own prefetch + module warming is the working
	// equivalent). Rules are MPA-mode (`router: false`) behavior, injected by the server handle.
	{
		const sp = await browser.newPage();
		await sp.goto(base + '/cart-a', { waitUntil: 'networkidle' });
		await sp.waitForTimeout(150);
		const rules = await sp.evaluate(
			() => document.querySelector('script[type="speculationrules"]') != null
		);
		check('speculate: NO rules script in SPA (router-on) mode', !rules);
		await sp.close();
	}

	// Isolation: a FRESH tab (new context) starts empty — the Keep is per-tab, server never remembers.
	const fresh = await browser.newContext();
	const fp = await fresh.newPage();
	await fp.goto(base + '/cart-a', { waitUntil: 'networkidle' });
	await fp.waitForTimeout(150);
	check('fresh tab: cart is empty (session-scoped, no server memory)', (await fp.locator('[data-sc-count]').innerText()) === '0', `count=${await fp.locator('[data-sc-count]').innerText()}`);
	await fresh.close();
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CONTINUITY CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
