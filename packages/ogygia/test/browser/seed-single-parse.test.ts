// THE PAGE SEED IS PARSED ONCE (runtime/seeds.ts). Two guards:
//   1. boot: N islands whose props REFERENCE the seed cost ONE seed parse (the old runtime parsed it
//      twice — once for `$page`, once per document for the references), the references resolve to
//      the very objects `page.data` holds, and the seed's text is blanked once it is in memory.
//   2. a reconcile navigation: the next page's island resolves its reference against the NEXT
//      page's seed — the stale-reference regression (a per-element cache the morph reused).
import { beforeEach, expect, inject, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';
import {
	PAGE_SEED_SELECTOR,
	apply_soft_invalidate_doc,
	page_seed_of,
	prepare_spa_document,
	seed_parse_count
} from '../../src/runtime/seeds.js';
import { reconcile_body, stamp_region_keys } from '../../src/runtime/reconcile.js';
import { morph_children } from '../../src/runtime/morph.js';
import { page_state } from '../../src/shims/page-store.svelte.js';

const HYDRATED = 'ogygia-region[data-hydrated]';
const decode = (key: 'counter_seedref_ssr_b64' | 'seed_nav_a_html_b64' | 'seed_nav_b_html_b64') =>
	decodeURIComponent(escape(atob(inject(key))));
const counts = () =>
	[...document.querySelectorAll('[data-testid="count"]')].map((e) => e.textContent);

beforeEach(() => {
	document.body.innerHTML = '';
	prepare_spa_document(); // a fresh document: session flags, page store, reader counts
});

test('boot: two seed-ref islands, ONE seed parse, refs by reference into page.data, seed text blanked', async () => {
	document.body.innerHTML = decode('counter_seedref_ssr_b64');
	// a TWIN: same fingerprint, so it shares the keyed sidecar (and must still get its props)
	const first = document.querySelector('ogygia-region')!;
	first.after(first.cloneNode(true));
	expect(document.querySelectorAll('ogygia-region').length).toBe(2);
	const seed_el = document.querySelector(PAGE_SEED_SELECTOR)!;
	const sidecar = document.querySelector('script[data-ogygia-props]')!;
	expect(seed_el.textContent!.length).toBeGreaterThan(0);
	const parses_before = seed_parse_count();

	bootDev();
	await expect.poll(() => document.querySelectorAll(HYDRATED).length, { timeout: 10_000 }).toBe(2);

	expect(counts()).toEqual(['3', '3']); // both islands got `start: 3` through the reference
	expect(seed_parse_count() - parses_before).toBe(1); // ONE parse for the store AND the references
	expect((page_state.data as { counter: { start: number } }).counter.start).toBe(3);
	expect(seed_el.textContent).toBe(''); // the graph lives in page_state now — no second reader
	expect(sidecar.textContent).toBe(''); // both readers done → the shared sidecar is released
});

test('reconcile navigation: the next page island reads the NEXT page seed (no stale reference)', async () => {
	const doc_a = new DOMParser().parseFromString(decode('seed_nav_a_html_b64'), 'text/html');
	document.body.innerHTML = doc_a.body.innerHTML;
	bootDev();
	await expect.poll(() => document.querySelectorAll(HYDRATED).length, { timeout: 10_000 }).toBe(1);
	expect(counts()).toEqual(['3']);
	expect(document.querySelector('[data-page-title]')!.textContent).toBe('page 3');

	// The router's navigation, piece by piece: preflight (parse the incoming seed on its document),
	// then inside the transition: prepare, seeds, reconcile.
	const doc_b = new DOMParser().parseFromString(decode('seed_nav_b_html_b64'), 'text/html');
	const parses_before = seed_parse_count();
	page_seed_of(doc_b);
	stamp_region_keys(doc_b.body);
	expect(seed_parse_count() - parses_before).toBe(1);

	prepare_spa_document();
	apply_soft_invalidate_doc(doc_b); // the SAME parse — not a second one
	reconcile_body(document.body, doc_b.body, morph_children);
	expect(seed_parse_count() - parses_before).toBe(1);
	expect((page_state.data as { counter: { start: number } }).counter.start).toBe(7);
	expect(document.querySelector('[data-page-title]')!.textContent).toBe('page 7');

	// the new page's island (a different fingerprint → a fresh mount) hydrates from page B's seed
	await expect
		.poll(
			() => document.querySelector('ogygia-region[data-og-fp^="bbbb"][data-hydrated]') !== null,
			{
				timeout: 10_000
			}
		)
		.toBe(true);
	expect(counts()).toEqual(['7']);
	// and nothing re-parsed the seed on the way: the live seed script arrived blank from preflight
	expect(seed_parse_count() - parses_before).toBe(1);
	expect(document.querySelector(PAGE_SEED_SELECTOR)!.textContent).toBe('');
});
