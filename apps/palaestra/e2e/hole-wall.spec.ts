// A HOLE ANSWER THAT IS NOT THE REGION'S IS REFUSED. `ogygia.handle()` answers a region request in
// place and never redirects; an app handle in front of it can still take the request (an auth wall,
// a locale bounce, a 404 handler) and the browser follows: what comes back is that handler's page.
// The runtime once swapped it in — on a customer site every hole of the header held the account
// area's page for signed-in visitors (skeletons, scripts requested from the wrong path, a header
// three screens tall). Now: a redirected answer or a whole-document body is refused, the fallback
// stands, no retry. The palaestra's `auth_wall` handle (hooks.server.ts) plays the app handle,
// switched by the `og-auth-wall` cookie.
//
//   pnpm exec playwright test hole-wall
import { test, check, sleep } from '@ogygia/tooling/e2e';

const HOLE_REQUEST_RE = /\/__ogygia__\?/;

test('control: no wall → the hole fills from the endpoint', async ({ page }) => {
	await page.goto('/hole-wall/', { waitUntil: 'networkidle' });
	await sleep(500);
	check('greeting served', (await page.locator('[data-server-greeting]').count()) === 1);
	check('fallback gone', (await page.locator('[data-wall-fallback]').count()) === 0);
});

for (const mode of ['redirect', 'document'] as const) {
	test(`${mode}: the hole answer is refused — fallback stands, nothing of the page enters, one request`, async ({
		page,
		context,
		baseURL
	}) => {
		await context.addCookies([{ name: 'og-auth-wall', value: mode, url: baseURL! }]);
		const hole_requests: string[] = [];
		page.on('request', (r) => {
			if (HOLE_REQUEST_RE.test(r.url())) hole_requests.push(r.url());
		});
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/hole-wall/', { waitUntil: 'networkidle' });
		await sleep(2000); // past the runtime's retry delays, had it retried
		check(
			`${mode}: fallback still there`,
			(await page.locator('[data-wall-fallback]').count()) === 1
		);
		check(
			`${mode}: no greeting (the endpoint never answered)`,
			(await page.locator('[data-server-greeting]').count()) === 0
		);
		check(
			`${mode}: nothing of the account page inside the document`,
			(await page.locator('[data-wall-skeleton], [data-account]').count()) === 0
		);
		// (this csr=false page carries its own `content="false"` fact; the injected page's is `true`)
		check(
			`${mode}: the csr meta of the injected page is NOT in this document`,
			(await page.locator('meta[name="ogygia-csr"][content="true"]').count()) === 0
		);
		check(
			`${mode}: region not marked hydrated`,
			(await page.locator('ogygia-region[render="defer"][data-hydrated]').count()) === 0
		);
		check(
			`${mode}: exactly ONE hole request (no retry of a deterministic refusal)`,
			hole_requests.length === 1,
			String(hole_requests.length)
		);
		check(`${mode}: no page errors`, errs.length === 0, errs.slice(0, 2).join('; '));
	});
}

// A REFUSED CAPABILITY IS A REFUSAL TOO. The endpoint's 403 is deterministic (its key, its MAC, its
// id) and says why: `x-ogygia-deny`, beside `x-ogygia-key` (the answering deployment's key
// fingerprint, which a capability carries as `&k=`). The field case: a CDN sent pages to one backend
// and the islands endpoint to another that signed with its own key — every hole 403'd four times
// over, and nothing said why. Played here by rewriting the hole's capability on its way out: `k`
// names a key this server does not sign with (another deployment), or `sig` is not this key's.
for (const [mode, param, value, deny] of [
	['foreign-key', 'k', '0ther0ky', 'foreign-key'],
	['sig', 'sig', 'AAAAAAAAAAAAAAAAAAAAAA', 'sig']
] as const) {
	test(`${mode}: a refused capability — one request, the reason in its headers, fallback stands`, async ({
		page
	}) => {
		const answers: { status: number; deny: string | null; key: string | null; k: string | null }[] =
			[];
		await page.route(HOLE_REQUEST_RE, async (route) => {
			const url = new URL(route.request().url());
			url.searchParams.set(param, value);
			const res = await route.fetch({ url: url.href });
			const h = res.headers();
			answers.push({
				status: res.status(),
				deny: h['x-ogygia-deny'] ?? null,
				key: h['x-ogygia-key'] ?? null,
				k: url.searchParams.get('k')
			});
			await route.fulfill({ response: res });
		});
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/hole-wall/', { waitUntil: 'networkidle' });
		await sleep(2000); // past the runtime's retry delays, had it retried
		check(
			`${mode}: exactly ONE hole request (no retry of a refused capability)`,
			answers.length === 1,
			String(answers.length)
		);
		const a = answers[0];
		check(
			`${mode}: 403 with x-ogygia-deny: ${deny}`,
			a?.status === 403 && a.deny === deny,
			JSON.stringify(a)
		);
		check(
			`${mode}: the answer names its key`,
			/^[0-9A-Za-z_-]{8}$/.test(a?.key ?? ''),
			String(a?.key)
		);
		if (mode === 'foreign-key')
			check('foreign-key: the two keys differ', a?.k === '0ther0ky' && a.key !== a.k);
		else
			check("sig: the capability names this server's key", a?.k === a?.key, `${a?.k} vs ${a?.key}`);
		check(
			`${mode}: fallback still there`,
			(await page.locator('[data-wall-fallback]').count()) === 1
		);
		check(`${mode}: no greeting`, (await page.locator('[data-server-greeting]').count()) === 0);
		check(`${mode}: no page errors`, errs.length === 0, errs.slice(0, 2).join('; '));
	});
}
