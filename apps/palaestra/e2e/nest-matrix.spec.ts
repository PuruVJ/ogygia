// Nesting matrix: a live snippet an island renders is part of that island. Every container × a lake
// holding a `visible` island (or the island alone): each inner island wakes, each lake keeps its server
// HTML, page contexts reach the snippet on both legs, and the host signals `ogygia:hydrated` only once
// its snippet content is live. The same matrix runs on a Kit-hydrated (csr=true) copy of the page.
// The field shape: a `wake: 'none'` lake inside a live snippet rendered bare (the snippet rendered in a
// root of its own, so nothing in it knew it was inside an island) and the island inside the lake
// waited on its host's hydration forever; next to an island the lake's HTML was discarded.
// Usage: pnpm exec playwright test nest-matrix
import type { Page } from '@playwright/test';
import { test, check, expect } from '@ogygia/tooling/e2e';

const CASES = [
	'shell-lake',
	'island-own-lake',
	'island-own-hole',
	'slot-lake',
	'snippet-lake',
	'snippet-island',
	'snippet-mixed',
	'snippet-hole',
	'snippet-args-lake',
	'snippet-forwarded-lake',
	'snippet-in-snippet-lake',
	'snippet-root-sibling',
	'snippet-root-hole',
	'snippet-module',
	'static-snippet-island',
	'hole-lake',
	'hole-wake-lake',
	'hole-island',
	'hole-wake-island'
];

/** How many lakes' HTML each case must still show after it wakes. */
const LAKES: Record<string, number> = {
	'shell-lake': 1,
	'island-own-lake': 1,
	'slot-lake': 1,
	'snippet-lake': 1,
	'snippet-mixed': 1,
	'snippet-args-lake': 2,
	'snippet-forwarded-lake': 2,
	'snippet-in-snippet-lake': 1,
	'hole-lake': 1,
	'hole-wake-lake': 1
};

function watch(page: Page): string[] {
	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	page.on('console', (m) => {
		const text = m.text();
		if (
			m.type() === 'error' ||
			text.includes('hydration_mismatch') ||
			text.includes('Failed to hydrate')
		)
			problems.push(text.slice(0, 200));
	});
	return problems;
}

for (const base of ['/nest-matrix', '/nest-matrix/kit']) {
	test.describe(`nesting matrix (${base === '/nest-matrix' ? 'csr=false' : 'Kit-hydrated'})`, () => {
		for (const c of CASES) {
			test(c, async ({ page }) => {
				const problems = watch(page);
				await page.goto(`${base}?only=${c}`, { waitUntil: 'networkidle' });
				const box = page.locator(`[data-case="${c}"]`);
				const bumpers = box.locator('[data-bumper]');
				const n = await bumpers.count();
				check(`${c}: its islands are in the page`, n > 0);
				for (let i = 0; i < n; i++) {
					const el = bumpers.nth(i);
					await el.scrollIntoViewIfNeeded();
					const count = el.locator('[data-bumper-n]');
					const before = Number(await count.innerText());
					// (a `visible` island wakes once in view: retry the click until it counts)
					let after = before;
					for (let t = 0; t < 20 && after === before; t++) {
						await el.click();
						await page.waitForTimeout(100);
						after = Number(await count.innerText());
					}
					check(
						`${c}: island ${i + 1} is live (click counts)`,
						after === before + 1,
						`${before} → ${after}`
					);
				}
				check(
					`${c}: every lake kept its server HTML`,
					(await box.locator('[data-snip-lake]').count()) === (LAKES[c] ?? 0)
				);
				check(`${c}: no hydration failure or error`, problems.length === 0, problems.join(' | '));
			});
		}

		test('page contexts reach a live snippet on both legs', async ({ page, baseURL }) => {
			const problems = watch(page);
			const raw = await (await fetch(`${baseURL}${base}?only=snippet-context`)).text();
			for (const label of ['direct', 'lake', 'island'])
				check(
					`SSR: ${label} reader sees the page context`,
					raw.includes(`data-ctx-read="${label}"`) && raw.includes('>v2'),
					label
				);
			await page.goto(`${base}?only=snippet-context`, { waitUntil: 'networkidle' });
			const reads = await page
				.locator('[data-case="snippet-context"] [data-ctx-read]')
				.evaluateAll((els) => els.map((e) => (e.firstChild?.textContent ?? '').trim()));
			check(
				'browser: every reader sees v2',
				reads.length === 3 && reads.every((v) => v === 'v2'),
				reads.join(',')
			);
			check('no hydration failure or error', problems.length === 0, problems.join(' | '));
		});
	});
}

// A hole in a live snippet keeps `render: 'deferred'`: the server ships its region and fallback (its
// content is off the HTML's critical path), the runtime fetches it, and the snippet's hydrate adopts it.
for (const c of ['snippet-hole', 'snippet-root-hole']) {
	test(`a hole in a live snippet stays deferred (${c})`, async ({ page, baseURL }) => {
		const raw = await (await fetch(`${baseURL}/nest-matrix?only=${c}`)).text();
		const snippet_at = raw.indexOf('<ogygia-snippet');
		const hole_at = raw.indexOf('render="defer"', snippet_at);
		check('SSR: the hole region sits inside the snippet', snippet_at > 0 && hole_at > snippet_at);
		check(
			'SSR: it carries a signed address',
			raw.slice(hole_at, raw.indexOf('>', hole_at)).includes('endpoint="')
		);
		check('SSR: its content is not in the page', !raw.includes('data-mx-hole'));
		const problems = watch(page);
		await page.goto(`/nest-matrix?only=${c}`, { waitUntil: 'networkidle' });
		const box = page.locator(`[data-case="${c}"]`);
		await box.locator('[data-mx-hole]').first().waitFor();
		check('browser: the hole landed', (await box.locator('[data-mx-hole]').count()) > 0);
		check(
			'browser: its fallback is gone',
			(await box.locator('[data-hole-fallback]').count()) === 0
		);
		check(
			'browser: its region kept its address',
			(await box.locator('ogygia-region[render="defer"][endpoint=""]').count()) === 0
		);
		check('no hydration failure or error', problems.length === 0, problems.join(' | '));
	});
}

// A hole in a live snippet that the island RE-CREATES in the browser (an `{#if}` hiding and showing
// it): created fresh, it renders its fallback again and fetches by its identity — on a page Kit loads
// and on one it does not.
for (const base of ['/nest-matrix', '/nest-matrix/kit']) {
	test(`a hole in a re-created live snippet shows its fallback and lands again (${base})`, async ({
		page
	}) => {
		await page.goto(`${base}?only=snippet-hole-recreate`, { waitUntil: 'networkidle' });
		const box = page.locator('[data-case="snippet-hole-recreate"]');
		await box.locator('[data-mx-hole]').waitFor();
		await box.locator('[data-toggle]').click();
		await expect(box.locator('[data-mx-hole]')).toHaveCount(0);
		await box.locator('[data-toggle]').click();
		await expect(box.locator('[data-mx-hole]'), 'the hole lands again').toHaveCount(1, {
			timeout: 10_000
		});
		check('its fallback is gone', (await box.locator('[data-hole-fallback]').count()) === 0);
		const bump = box.locator('[data-bumper]');
		await bump.scrollIntoViewIfNeeded();
		const before = Number(await bump.locator('[data-bumper-n]').innerText());
		let after = before;
		for (let t = 0; t < 20 && after === before; t++) {
			await bump.click();
			await page.waitForTimeout(100);
			after = Number(await bump.locator('[data-bumper-n]').innerText());
		}
		check('the island in its answer is live', after === before + 1, `${before} → ${after}`);
	});
}

test('the host signals ogygia:hydrated only once its live snippet content mounted', async ({
	page
}) => {
	await page.addInitScript(() => {
		const w = window as unknown as { __mounted_at_hydrated?: boolean | null };
		w.__mounted_at_hydrated = null;
		document.addEventListener('ogygia:hydrated', (e) => {
			const host = e.target as Element;
			if (!host.querySelector('ogygia-snippet')) return;
			w.__mounted_at_hydrated =
				!!host.querySelector('[data-mx-mounted][data-mounted]') &&
				host.hasAttribute('data-hydrated');
		});
	});
	await page.goto('/nest-matrix?only=snippet-timing', { waitUntil: 'networkidle' });
	const seen = await page.evaluate(
		() => (window as unknown as { __mounted_at_hydrated?: boolean | null }).__mounted_at_hydrated
	);
	check('the host fired ogygia:hydrated', seen !== null);
	check('its snippet content had mounted by then', seen === true);
});
