// Islands inside a `{#snippet}` handed to a PLAIN shell that renders it SAME-GRAPH on a csr=false
// page (the ShowcaseCard shape). Two regressions guarded:
//  1. mark preservation — the portable-snippet synth must emit the ORIGINAL `with { wake }` import,
//     so the island placed in the snippet body stays a real `<ogygia-region>` in the entry (a
//     cleaned import demoted it to a plain dead component);
//  2. async threading — the live snippet's server leg renders through the OUTER async renderer
//     (renderer.child), so a top-level `await` in the island body resolves INTO the SSR HTML
//     instead of throwing `await_invalid` (the docs-home 500).
// Usage: pnpm exec playwright test snippet-islands
import { test, check, island_graph } from './fixtures/index.ts';
import { REGION_TAG_G_RE } from './fixtures/re.ts';

const SNIPPET_FRAME_RE = /<ogygia-snippet[\s\S]*?<\/ogygia-snippet>/;
/** The card's stage, where the plain card renders the snippet it was handed. */
const SNIPPET_STAGE_RE = /<div data-snippet-stage[^>]*>[\s\S]*?<\/section>/;
const RESOLVED_GREETING_RE = /data-resolved-greeting/;
const RESOLVED_AT_SSR_RE = /Resolved at SSR/;
const IN_SNIPPET_RE = /in-snippet/;
const BUMPER_SEED_RE = /data-bumper-n[^>]*>3</;
const ENTRY_HASH_RE = /entry="([^"]*og-region\.[0-9a-f]+\.js)"/g;

test.describe('islands in a {#snippet} to a plain shell: marks survive + top-level await SSRs', () => {
	test('SSR', async ({ baseURL }) => {
		const res = await fetch(baseURL + '/snippet-islands');
		check('SSR: page renders (no await_invalid 500)', res.status === 200, `status=${res.status}`);
		const raw = await res.text();

		// The snippet rendered IN PLACE in the card (same tree: the host's context and scope) — not
		// through an isolated portable frame, which only a crossing into an island uses…
		const frame = raw.match(SNIPPET_STAGE_RE)?.[0] ?? '';
		check('SSR: the snippet rendered in the card’s stage', frame.length > 0);
		check('SSR: in place, not an isolated portable frame', !SNIPPET_FRAME_RE.test(frame));
		// …and the islands inside it are REAL regions (page islands, in Kit's page pass).
		const regions = (frame.match(REGION_TAG_G_RE) ?? []).length;
		check('SSR: islands inside the snippet stay regions', regions >= 2, `regions=${regions}`);
		// The top-level `await` resolved DURING SSR — its content is in the server HTML.
		check(
			'SSR: awaited island content resolved server-side',
			RESOLVED_GREETING_RE.test(frame) && RESOLVED_AT_SSR_RE.test(frame)
		);
		check('SSR: awaited remote data baked in (name crossed)', IN_SNIPPET_RE.test(frame));
		// The interactive island's seed is server-rendered too.
		check('SSR: nested interactive island seeded (3)', BUMPER_SEED_RE.test(frame));
		// Each snippet-nested island carries its island graph (a page island like any other), so it
		// preloads its whole graph at wake.
		const graph = island_graph(raw);
		const entryHashes = [...frame.matchAll(ENTRY_HASH_RE)].map((m) => m[1]);
		const listed = entryHashes.filter((h) => graph.has(h));
		check(
			'SSR: snippet-nested island entries carry their island graph',
			entryHashes.length > 0 && listed.length === entryHashes.length,
			`${listed.length}/${entryHashes.length} listed; graph keys ${[...graph.keys()].join(', ')}`
		);
	});

	test('Browser', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/snippet-islands', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);

		const greeting = page.locator('[data-snippet-stage] [data-resolved-greeting]');
		check(
			'awaited island survives hydration (not wiped)',
			IN_SNIPPET_RE.test(await greeting.innerText())
		);

		const n = page.locator('[data-snippet-stage] [data-bumper-n]');
		check('interactive island seed after hydration', (await n.innerText()) === '3');
		await page.locator('[data-snippet-stage] [data-bumper]').click();
		await page.waitForTimeout(60);
		check(
			'island inside snippet is ALIVE — 3 → 4',
			(await n.innerText()) === '4',
			`n=${await n.innerText()}`
		);

		check('no page errors', errors.length === 0, errors.join(' | '));
	});
});
