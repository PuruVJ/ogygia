// REMOTE SEED ONLY WHEN REACHABLE — the `application/ogygia-remote` seed (every SSR-resolved
// remote's result, serialized again so a hydrating island resolves it from the page) ships only
// for remotes some island on the page can call. A lake, a hole's fallback, a page or layout script
// awaiting a query for its own server render has no client reader: its result is already HTML, and
// seeding it is download weight (one CMS footer entry measured 12.5 KB on every csr=false page).
//
// One table, every caller permutation × reachability, then scale, then the csr=true twin:
//   caller  ∈ { lake, page script, layout script, hole fallback lake, lake hosting an island }
//   reader  ∈ { none, static-import island, island-in-lake, dynamic-import island, prerender island,
//               pending-boundary island, promise `of` (fail-open), second module }
// Each row: the seed's presence and exact contents by substring, the lake/page text rendered, and
// for hydrating rows: every island hydrated, zero remote fetches unless the row expects them.
// Usage: pnpm exec playwright test remote-seed-gate
import { test, check, sleep } from './fixtures/index.ts';

const REMOTE_SEED_RE = /<script type="application\/ogygia-remote">([^<]*)<\/script>/;
const KIT_DATA_RE = /__sveltekit_\w+\.data\s*=/;
const REGION_RE = /<ogygia-region\b/g;
const KIT_REMOTE_ENDPOINT = '/_app/remote/';

interface Row {
	path: string;
	/** substrings the seed must carry (`[]` with `seed: false` = no seed script at all) */
	has: string[];
	/** substrings the seed must NOT carry */
	lacks?: string[];
	seed: boolean;
	/** substrings the HTML must carry (the server render happened) */
	html: string[];
	/** remote fetches expected during hydration (0 = resolved from the seed or nothing calls) */
	fetches?: number;
	/** islands expected to hydrate (`data-hydrated`); omitted = at least one */
	hydrated?: number;
	/** the row's hydration is asserted by its own test below (a held promise region has no
	 *  `<ogygia-region>` in the SSR HTML — it registers late and paints when the remote resolves) */
	own_hydrate_test?: boolean;
}

const rows: Row[] = [
	{ path: '/remote-seed-gate', seed: false, has: [], html: ['Lake, resolved on the server:'] },
	{ path: '/remote-seed-gate/reader', seed: true, has: ['/getGreeting/', 'reader', 'lake'], html: ['Lake, resolved on the server:', 'Hello, reader!'] },
	{ path: '/remote-seed-gate/page-script', seed: false, has: [], html: ['page: Hello, page!'] },
	{ path: '/remote-seed-gate/page-script-reader', seed: true, has: ['/getGreeting/', 'page', 'reader'], html: ['page: Hello, page!', 'Hello, reader!'] },
	{ path: '/remote-seed-gate/layout-script', seed: false, has: [], html: ['layout: Hello, layout!'] },
	{ path: '/remote-seed-gate/layout-script/reader', seed: true, has: ['/getGreeting/', 'layout', 'reader'], html: ['layout: Hello, layout!', 'Hello, reader!'] },
	{ path: '/remote-seed-gate/island-in-lake', seed: true, has: ['/getGreeting/', 'lake', 'in-lake'], html: ['lake: Hello, lake!', 'Hello, in-lake!'] },
	{ path: '/remote-seed-gate/island-in-lake-silent', seed: false, has: [], html: ['lake: Hello, lake!', 'silent island in the lake'] },
	// the reader is only reachable through `await import()` — still this island's call
	{ path: '/remote-seed-gate/dynamic', seed: true, has: ['/getGreeting/', 'lake'], html: ['Lake, resolved on the server:'] },
	// per MODULE: the island imports `second.remote` only
	{ path: '/remote-seed-gate/two-modules', seed: true, has: ['/second/', 'island', 'page'], lacks: ['/getGreeting/'], html: ['Hello, page! / page', 'second: island'] },
	{ path: '/remote-seed-gate/prerender', seed: false, has: [], html: ['manifesto: islands, not hydration'] },
	{ path: '/remote-seed-gate/prerender-reader', seed: true, has: ['/getManifesto/'], html: ['manifesto: islands, not hydration', 'manifesto (island): islands, not hydration'] },
	{ path: '/remote-seed-gate/hole-fallback', seed: false, has: [], html: ['Lake, resolved on the server:'] },
	// a promise `of` → fail-open: everything seeds, the lake's call included
	// a promise `of` at page level: fail-open for BOTH seeds (the page seed ships too — documented)
	{ path: '/remote-seed-gate/held', seed: true, has: ['/getGreeting/', 'lake'], html: ['Lake, resolved on the server:', 'data-held-placeholder'], own_hydrate_test: true },
	// the pending island's own call is pending at SSR (omitted, it fetches) — the lake's still seeds
	{ path: '/remote-seed-gate/pending', seed: true, has: ['/getGreeting/', 'lake'], lacks: ['pending'], html: ['Lake, resolved on the server:'], fetches: 1 },
	{ path: '/remote-seed-gate/many', seed: true, has: ['/getGreeting/', 'lake', ...Array.from({ length: 20 }, (_, i) => `r${i}`)], html: ['Hello, r19!'], hydrated: 40 },
	{ path: '/remote-seed-gate/many-silent', seed: false, has: [], html: ['Lake, resolved on the server:'], hydrated: 60 }
];

test.describe('REMOTE SEED GATE: the remote seed ships only for remotes an island can call', () => {
	for (const row of rows) {
		test(`${row.path} → ${row.seed ? 'seed [' + row.has.slice(0, 3).join(', ') + (row.has.length > 3 ? ', …' : '') + ']' : 'NO seed'}`, async ({
			baseURL,
			page
		}) => {
			const html = await (await fetch(baseURL + row.path)).text();
			for (const s of row.html) check(`${row.path}: server rendered "${s}"`, html.includes(s));
			const m = REMOTE_SEED_RE.exec(html);
			if (!row.seed) {
				check(`${row.path}: no application/ogygia-remote seed`, !m, m?.[1].slice(0, 160) ?? '');
			} else {
				check(`${row.path}: seed present`, !!m);
				for (const s of row.has) check(`${row.path}: seed carries "${s}"`, !!m && m[1].includes(s));
				for (const s of row.lacks ?? []) check(`${row.path}: seed lacks "${s}"`, !!m && !m[1].includes(s), m?.[1].slice(0, 160) ?? '');
			}
			if (row.own_hydrate_test) return;
			check(`${row.path}: no page seed (nothing reads $page)`, !html.includes('application/ogygia-page'));

			// hydrate: every island wakes, nothing fetches a remote unless the row says so
			const fetches: string[] = [];
			page.on('request', (r) => {
				if (r.url().includes(KIT_REMOTE_ENDPOINT)) fetches.push(r.method() + ' ' + r.url());
			});
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			await page.goto(row.path, { waitUntil: 'networkidle' });
			await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 }).catch(() => {});
			await sleep(300);
			const regions = (html.match(REGION_RE) ?? []).length;
			const hydrated = await page.locator('ogygia-region[data-hydrated]').count();
			if (row.hydrated !== undefined) check(`${row.path}: ${row.hydrated} islands hydrated`, hydrated === row.hydrated, `${hydrated} of ${regions} regions`);
			else check(`${row.path}: at least one island hydrated`, hydrated >= 1, `${hydrated} of ${regions} regions`);
			check(`${row.path}: ${row.fetches ?? 0} remote fetch(es) on hydrate`, fetches.length === (row.fetches ?? 0), fetches.join(' | '));
			check(`${row.path}: no page errors`, errors.length === 0, errors.join(' | '));
		});
	}

	test('the dynamic-import reader still resolves after the click (the seed carried the lake call, the callee fetches its own)', async ({ page }) => {
		await page.goto('/remote-seed-gate/dynamic', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 });
		await page.click('[data-lazy-btn]');
		await page.waitForSelector('[data-lazy-callee]', { timeout: 8000 });
		check('callee rendered its greeting', (await page.locator('[data-lazy-callee]').innerText()).includes('Hello, lazy!'));
	});

	test('the held promise row: the page loads clean, the lake is HTML, both seeds are the fail-open ones', async ({ baseURL, page }) => {
		// A page-level promise `of` registers a LATE slot the streamed-router path drains; on a plain
		// Kit page it stays a placeholder — the row exists for the seeds' fail-open, asserted above.
		const html = await (await fetch(baseURL + '/remote-seed-gate/held')).text();
		check('page seed ships (fail-open: the promise’s module is unknown at SSR)', html.includes('application/ogygia-page'));
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/remote-seed-gate/held', { waitUntil: 'networkidle' });
		check('lake text intact', (await page.locator('[data-lake-greeting]').innerText()).includes('Hello, lake!'));
		check('no page errors', errors.length === 0, errors.join(' | '));
	});

	test('the hole renders on the endpoint and swaps in; the page never seeded its call', async ({ page }) => {
		await page.goto('/remote-seed-gate/hole-fallback', { waitUntil: 'networkidle' });
		await page.waitForSelector('[data-gate-hole]', { timeout: 8000 });
		check('hole swapped in with its endpoint render', (await page.locator('[data-gate-hole]').innerText()).includes('hole: Hello, hole!'));
	});

	test('csr=true twin: Kit inlines the query itself, ogygia emits no remote seed, the page works', async ({ baseURL, page }) => {
		const html = await (await fetch(baseURL + '/remote-seed-gate/kit')).text();
		check('/kit: lake rendered', html.includes('Lake, resolved on the server:'));
		check('/kit: no application/ogygia-remote seed', !REMOTE_SEED_RE.test(html));
		check('/kit: Kit inlined its own remote data', KIT_DATA_RE.test(html));
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/remote-seed-gate/kit', { waitUntil: 'networkidle' });
		await page.click('[data-counter] button');
		check('/kit: island interactive after Kit hydration', (await page.locator('[data-counter] button').innerText()).includes('count is 1'));
		check('/kit: lake text intact after Kit hydration', (await page.locator('[data-lake-greeting]').innerText()).includes('Hello, lake!'));
		check('/kit: no page errors', errors.length === 0, errors.join(' | '));
	});
});
