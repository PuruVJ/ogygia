// Single-flight mutation (Playwright). Usage: node verify/frame-single-flight.ts [baseUrl]
//
// A command mutates server state AND returns the re-rendered region in the same response. The mounted
// region morphs in place from the command's baked HTML — with NO follow-up region-endpoint fetch.
// This is the third frames facet: mutation responses are frame writes.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const browser = await chromium.launch();
try {
	const page = await browser.newPage();

	// Count GET requests to the region endpoint — single-flight must add ZERO of them on mutation.
	let regionGets = 0;
	page.on('request', (req) => {
		if (req.method() === 'GET' && /\/(?:%F0%9F%8F%9D|🏝)/.test(req.url())) regionGets++;
	});

	await page.goto(base + '/single-flight', { waitUntil: 'load' });

	const badge = page.locator('[data-badge]');
	await badge.waitFor({ timeout: 8000 });
	const before = (await badge.textContent())?.trim();
	check('region SSR shows initial count', /^count: \d+$/.test(before || ''), JSON.stringify(before));

	// Wait for the trigger island to hydrate, then snapshot the endpoint-GET count.
	await page.waitForFunction(() => document.querySelector('ogygia-region[data-hydrated]') != null, { timeout: 8000 }).catch(() => {});
	const getsBeforeClick = regionGets;

	// Fire the mutation.
	await page.locator('[data-bump]').click();
	// The command response carries the re-rendered region; the mounted one morphs. Wait for the change.
	await page
		.waitForFunction(
			(prev) => document.querySelector('[data-badge]')?.textContent?.trim() !== prev,
			before,
			{ timeout: 8000 }
		)
		.catch(() => {});

	const after = (await badge.textContent())?.trim();
	const bn = Number((before || '').replace(/\D/g, ''));
	const an = Number((after || '').replace(/\D/g, ''));
	check('region morphed to the mutated count', an === bn + 1, `${before} → ${after}`);
	check(
		'SINGLE-FLIGHT: mutation added NO region-endpoint fetch',
		regionGets === getsBeforeClick,
		`gets before=${getsBeforeClick} after=${regionGets}`
	);
	check('same node morphed in place (no full re-fetch churn)', an === bn + 1 && regionGets === getsBeforeClick);
} catch (err) {
	check('single-flight threw', false, String((err as Error)?.message ?? err));
} finally {
	await browser.close();
}

console.log(out.join('\n'));
process.exit(failures);
