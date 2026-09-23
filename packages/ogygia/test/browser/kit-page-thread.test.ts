// An island of OURS on a Kit-hydrated (csr=true) document — here inside a lake, the served header
// shape — reads `page.data` through the bridge Kit's client entry publishes (there is no ogygia page
// seed on a Kit document; Kit's data is the truth). That entry arrives by Kit's boot `import()`, a
// network fetch, while the island is already in the SSR tree and wakes on its own schedule. REGRESSION
// (customer, prod, ~1 in 3 loads): a `wake:'idle'` search-bar island woke while Kit's chunks were still
// downloading, read `page.data` as `{}`, its `{#if page.data.loggedIn}{:else if markup}` took the
// empty branch, and Svelte discarded the server DOM — the search bar vanished. The runtime must not
// hydrate such an island before Kit's page thread exists; its server HTML stays on screen meanwhile.
import { afterEach, expect, inject, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';
import { publish_kit_page, unpublish_kit_page } from './_kit-thread.js';

const ISLAND = 'ogygia-region[wake="idle"]';
const inject_html = (key: 'lake_page_reader_ssr_b64') => decodeURIComponent(escape(atob(inject(key))));

afterEach(() => {
	unpublish_kit_page();
	document.body.innerHTML = '';
});

test('a page-reading island inside a lake on a Kit document waits for Kit’s page thread, then hydrates on the SAME branch', async () => {
	const warns: string[] = [];
	const real_warn = console.warn;
	console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
	try {
		// Kit's bootstrap marks the document; its client entry (the thread) has NOT run yet.
		document.body.innerHTML =
			'<script>__sveltekit_lab = {};</script>' + '<div data-mount>' + inject_html('lake_page_reader_ssr_b64') + '</div>';
		const island = document.querySelector(ISLAND) as HTMLElement;
		expect(island, 'the fixture is the lake + idle island shape').not.toBeNull();
		const server_branch = island.querySelector('[data-testid="search"]');
		expect(server_branch?.textContent, 'the server took the markup branch').toBe('search');

		bootDev();

		// The island is ours (inside a lake) and wakes on idle — but Kit's page is not there yet, so it
		// must HOLD: no hydrate, no discard, the server DOM untouched.
		await new Promise((r) => setTimeout(r, 600));
		expect(island.hasAttribute('data-hydrated'), 'held until the thread exists').toBe(false);
		expect(island.querySelector('[data-testid="search"]'), 'the server node is still there').toBe(server_branch);
		expect(warns.filter((w) => w.includes('discarded its ENTIRE'))).toEqual([]);

		// Kit's entry runs: the thread publishes Kit's page — the same data the server rendered from.
		publish_kit_page({ searchBarMarkup: '<i data-testid="search">search</i>' });

		await expect.poll(() => island.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		// Same branch as the server → the server DOM was claimed, not discarded.
		expect(island.hasAttribute('data-og-recovered'), 'no discard').toBe(false);
		expect(island.querySelector('[data-testid="search"]'), 'the SSR node was adopted').toBe(server_branch);
		expect(island.querySelector('[data-testid="branch"]')?.textContent).toBe('search');
		expect(warns.filter((w) => w.includes('discarded its ENTIRE'))).toEqual([]);
	} finally {
		console.warn = real_warn;
	}
});

test('with the thread already published at wake there is no hold: the island hydrates straight away', async () => {
	publish_kit_page({ searchBarMarkup: '<i data-testid="search">search</i>' });
	document.body.innerHTML =
		'<script>__sveltekit_lab = {};</script>' + '<div data-mount>' + inject_html('lake_page_reader_ssr_b64') + '</div>';
	const island = document.querySelector(ISLAND) as HTMLElement;
	bootDev();
	await expect.poll(() => island.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
	expect(island.hasAttribute('data-og-recovered')).toBe(false);
	expect(island.querySelector('[data-testid="branch"]')?.textContent).toBe('search');
});
