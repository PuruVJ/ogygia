// REVERSIBLE TRANSFORMS, end to end (ogygia.handle({ transform }), server/reversible.ts +
// runtime/restore.ts): the built palaestra, served with OGYGIA_RESTORE_LAB=1, runs a scoped
// web-component render (apps/palaestra/src/lib/restorelab/scoped-render.ts) over every document and
// region answer. On /restore-lab the island inside a reshaped host must hydrate without a heal and
// stay interactive, the parser must not split the page's link or <p> around a host's tree, the hole's
// answer must arrive restored (its island hydrating after), a server-owned host is left for its own
// runtime, and nothing of ogygia's marking is left in the DOM.
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawn_server, type SpawnedServer } from '@ogygia/tooling/e2e/servers.ts';

const PORT = 4186;
const base = `http://127.0.0.1:${PORT}`;
const palaestra = fileURLToPath(new URL('..', import.meta.url));
let srv: SpawnedServer | null = null;

test.use({ baseURL: base });
test.beforeAll(async () => {
	// (the suite's webServer already built the palaestra: serve that build with the lab's transform)
	srv = await spawn_server({
		cmd: process.execPath,
		args: [
			'node_modules/vite/bin/vite.js',
			'preview',
			'--port',
			String(PORT),
			'--strictPort',
			'--host',
			'127.0.0.1'
		],
		cwd: palaestra,
		env: { OGYGIA_RESTORE_LAB: '1', ORIGIN: base },
		url: `${base}/restore-lab`,
		timeout_ms: 60_000
	});
});
test.afterAll(() => srv?.kill());

test('the island inside a reshaped host hydrates as is, and stays interactive', async ({
	page
}) => {
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/restore-lab');
	const island = page.locator('ogygia-region[data-hydrated]').first();
	await expect(island).toBeAttached();
	await page.locator('[data-lab-count]').click();
	await expect(page.locator('[data-lab-count]')).toHaveText('count 1');
	const facts = await page.evaluate(() => {
		const card = document.querySelector('[data-lab-card]')!;
		return {
			healed: document.querySelectorAll('[data-og-healed],[data-og-recovered]').length,
			shadow_title: card.shadowRoot?.querySelector('b')?.textContent ?? null,
			sheets: card.shadowRoot?.adoptedStyleSheets.length ?? 0,
			host_class: card.getAttribute('class'),
			kept: card.hasAttribute('data-rendered'),
			light: card.innerHTML,
			marks: document.querySelectorAll('[og-h],[og-c],[og-u],[og-r],[og-shadow],og-as').length,
			link_whole: !!document.querySelector('a[data-lab-link] demo-link'),
			p_whole: !!document.querySelector('p[data-lab-p] demo-card[data-lab-inline]'),
			server_left: !document.querySelector('[data-server-card]')!.shadowRoot
		};
	});
	expect(facts.healed).toBe(0);
	expect(facts.shadow_title).toBe('Card title');
	expect(facts.sheets).toBe(1);
	// Svelte's class back (beside the token the render put on its own host: a custom element's class is
	// shared with its component — runtime/restore.ts `reset`, kept through the island's hydrate), the
	// renderer's kept attribute stays, the whitespace the render trimmed is back
	expect(facts.host_class).toBe('own sc-demo-card-h');
	expect(facts.kept).toBe(true);
	expect(facts.light).toContain('some   text');
	expect(facts.marks).toBe(0);
	expect(facts.link_whole).toBe(true);
	expect(facts.p_whole).toBe(true);
	expect(facts.server_left).toBe(true);
	expect(errors).toEqual([]);
});

test('a hole’s answer arrives restored, and its island hydrates after', async ({ page }) => {
	await page.goto('/restore-lab');
	await expect(page.locator('[data-hole-count]')).toBeVisible();
	await page.locator('[data-hole-count]').click();
	await expect(page.locator('[data-hole-count]')).toHaveText('hole count 1');
	const hole = await page.evaluate(() => {
		const card = document.querySelector('[data-hole-card]')!;
		return {
			shadow: !!card.shadowRoot,
			sheets: card.shadowRoot?.adoptedStyleSheets.length ?? 0,
			healed: document.querySelectorAll('[data-og-healed],[data-og-recovered]').length,
			head_sheets: document.head.querySelectorAll('template[data-og-head="demo-card.shadow"]')
				.length
		};
	});
	expect(hole).toEqual({ shadow: true, sheets: 1, healed: 0, head_sheets: 1 });
});

test('a router navigation away and back: every restored host has its sheet, and nothing throws', async ({
	page
}) => {
	// REGRESSION (field report on 4e800c75): after a router navigation every restored host lost its
	// sheet — the restorer's adopt step threw on a root left in the incoming page's parsed document
	// ("Sharing constructed stylesheets in multiple documents") and stopped before the roots that went in
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/restore-lab');
	await expect(page.locator('[data-hole-count]')).toBeVisible();
	await page.evaluate(() => {
		const a = document.createElement('a');
		a.href = '/plain';
		a.setAttribute('data-lab-away', '');
		a.textContent = 'away';
		document.body.append(a);
	});
	const documents: string[] = [];
	page.on('request', (r) => r.resourceType() === 'document' && documents.push(r.url()));
	await page.locator('[data-lab-away]').click();
	await expect(page).toHaveURL(/\/plain$/);
	// the address moves before the page arrives: go back only once /plain is on screen (a back while
	// it loads cancels the trip — router-race.spec — and the way back would restore nothing)
	await expect(page.locator('h1')).toContainText('Plain page');
	await page.goBack();
	await expect(page).toHaveURL(/\/restore-lab$/);
	await expect(page.locator('[data-hole-count]')).toBeVisible();
	const hosts = await page.evaluate(() =>
		[...document.querySelectorAll('demo-card, demo-link')]
			.filter((h) => h.shadowRoot)
			.map((h) => ({ host: h.localName, sheets: h.shadowRoot!.adoptedStyleSheets.length }))
	);
	expect(documents, 'both ways were router navigations').toEqual([]);
	expect(hosts.length).toBeGreaterThanOrEqual(3);
	expect(hosts.filter((h) => h.sheets !== 1)).toEqual([]);
	expect(errors).toEqual([]);
});

test('a router navigation morphs a server-owned host its own runtime unpacked, without the transform’s tree in its light DOM', async ({
	page
}) => {
	// REGRESSION (field report on 0.8.4): a site nav (a server-owned custom element the transform renders
	// in scoped form, unpacked by its own runtime on first load) collapsed to one unstyled item after an
	// in-place navigation — the incoming page carried the host in the transform's first-load form, and
	// the morph put that tree into the live host's light DOM. A router-fetched page is an answer now:
	// every host planned and restored before the swap.
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/restore-lab/nav-a');
	const nav = page.locator('demo-nav[data-nav]');
	await expect.poll(() => nav.evaluate((el) => !!el.shadowRoot)).toBe(true);
	const shape = () =>
		page.evaluate(() => {
			const host = document.querySelector('demo-nav[data-nav]')!;
			return {
				cids: document.querySelectorAll('[c-id]').length,
				light: [...host.children].map((c) => c.localName),
				tabs: host.querySelectorAll(':scope > ul > li').length,
				shadow_nav: !!host.shadowRoot?.querySelector('nav')
			};
		});
	expect(await shape()).toEqual({ cids: 0, light: ['ul'], tabs: 7, shadow_nav: true });
	const documents: string[] = [];
	page.on('request', (r) => r.resourceType() === 'document' && documents.push(r.url()));
	await page.locator('[data-nav-go]').click();
	await expect(page.locator('[data-nav-page="b"]')).toBeVisible();
	expect(documents, 'an in-place navigation').toEqual([]);
	expect(await shape()).toEqual({ cids: 0, light: ['ul'], tabs: 7, shadow_nav: true });
	expect(errors).toEqual([]);
});

test('a first-load copy reaching the router (a store, a prerender, a cache that ignores Vary) is loaded, never swapped in', async ({
	page,
	request
}) => {
	await page.goto('/restore-lab/nav-a');
	await expect
		.poll(() => page.locator('demo-nav[data-nav]').evaluate((el) => !!el.shadowRoot))
		.toBe(true);
	// the router's fetch gets the copy a full load gets
	const first_load = await (await request.get('/restore-lab/nav-b')).text();
	await page.route('**/restore-lab/nav-b', (route) =>
		route.request().headers()['x-ogygia-spa']
			? route.fulfill({ body: first_load, contentType: 'text/html' })
			: route.continue()
	);
	const documents: string[] = [];
	page.on('request', (r) => r.resourceType() === 'document' && documents.push(r.url()));
	await page.locator('[data-nav-go]').click();
	await expect(page.locator('[data-nav-page="b"]')).toBeVisible();
	expect(
		documents.some((u) => u.endsWith('/restore-lab/nav-b')),
		'the router handed it to a full load'
	).toBe(true);
	await expect
		.poll(() => page.locator('demo-nav[data-nav]').evaluate((el) => !!el.shadowRoot))
		.toBe(true);
	expect(await page.evaluate(() => document.querySelectorAll('[c-id]').length)).toBe(0);
});

test('a router-fetched page is rendered as an answer: every host planned, and the response varies on it', async ({
	request
}) => {
	const load = await request.get('/restore-lab/nav-b');
	const nav = await request.get('/restore-lab/nav-b', { headers: { 'x-ogygia-spa': '1' } });
	const load_html = await load.text();
	const nav_html = await nav.text();
	// loaded as a document: the server-owned nav is left in the transform's form, marked first-load
	expect(load_html).toContain('<meta name="ogygia-first-load">');
	expect(load_html).not.toMatch(/<demo-nav[^>]* og-h=/);
	// fetched by the router: planned (the restorer puts it back before the swap), no first-load mark
	expect(nav_html).not.toContain('ogygia-first-load');
	expect(nav_html).toMatch(/<demo-nav[^>]* og-h=/);
	expect((load.headers()['vary'] ?? '').toLowerCase()).toContain('x-ogygia-spa');
	expect((nav.headers()['vary'] ?? '').toLowerCase()).toContain('x-ogygia-spa');
});
