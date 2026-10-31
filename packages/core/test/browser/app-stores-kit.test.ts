// `$page` inside an island on a Kit-booted document: a store over Kit's REAL reactive `page` (the
// kit-page thread publishes it), built from `$app/state` — Kit 3 removed `$app/stores` (subscribing to
// it throws), so the thread no longer hands over Kit's store. The subscription must stay live through
// Kit's page updates, and an unchanged page is not passed on twice.
import { afterEach, expect, test } from 'vitest';
import { flushSync } from 'svelte';
import { page, getStores } from '../../src/shims/app-stores.ts';
import { publish_kit_page_deferred, unpublish_kit_page } from './_kit-thread.svelte.ts';

afterEach(unpublish_kit_page);

test('$page follows Kit’s page through updates, once per change', () => {
	const kit = publish_kit_page_deferred();
	kit.settle({ n: 1 });
	const seen: unknown[] = [];
	const off = page.subscribe((v) => seen.push(v.data.n));
	flushSync();
	expect(seen).toEqual([1]);
	kit.settle({ n: 2 });
	flushSync();
	expect(seen).toEqual([1, 2]);
	off();
	kit.settle({ n: 3 });
	flushSync();
	expect(seen).toEqual([1, 2]);
});

test('getStores() hands back the shim stores', () => {
	expect(getStores().page).toBe(page);
});
