// Streaming server islands (Feature B) — the PURE scanner/parcel layer. The `handle()` body-stream
// wrapper uses these to find immediate deferred holes, key each parcel to the region's capability
// signature, and build/read parcel markup. DOM delivery is covered by the browser suite
// `verify/stream.ts`. Runs against `../dist`.

import { describe, test, expect } from 'vitest';
import {
	find_streamable_regions,
	region_slot_key,
	build_parcel,
	done_parcel,
	STREAM_DONE_SLOT
} from '../dist/server/stream-regions.js';

const ENDPOINT = '/%F0%9F%8F%9D?id=abc123abc123&props=ey000&exp=9999999999&sig=SIGVALUE';

function regionTag(attrs: string) {
	// `&` escaped as Svelte would emit it in an attribute value.
	return `<ogygia-region ${attrs.replace(/&/g, '&amp;')}>fallback</ogygia-region>`;
}

describe('region_slot_key', () => {
	test('extracts the capability sig as the slot key', () => {
		expect(region_slot_key(ENDPOINT)).toBe('SIGVALUE');
	});
	test('null when there is no query / sig', () => {
		expect(region_slot_key('/nope')).toBeNull();
		expect(region_slot_key('/x?id=1')).toBeNull();
	});
});

describe('find_streamable_regions', () => {
	test('finds a render="defer" when="load" hole and decodes its endpoint', () => {
		const html = `<div>${regionTag(`entry="abc" render="defer" when="load" endpoint="${ENDPOINT}"`)}</div>`;
		const found = find_streamable_regions(html);
		expect(found).toHaveLength(1);
		expect(found[0].slot).toBe('SIGVALUE');
		// The `&amp;` in the attribute is decoded back to `&` for the real fetch/verify.
		expect(found[0].endpoint).toContain('&props=');
		expect(found[0].endpoint).not.toContain('&amp;');
	});

	test('skips idle / visible / media defers (their SERVER work is intentionally deferred)', () => {
		const html =
			regionTag(`render="defer" when="idle" endpoint="${ENDPOINT}"`) +
			regionTag(`render="defer" when="visible" endpoint="${ENDPOINT}"`) +
			regionTag(`render="defer" when="(min-width: 700px)" endpoint="${ENDPOINT}"`);
		expect(find_streamable_regions(html)).toHaveLength(0);
	});

	test('skips live partials and hydrate-only islands (no render=defer / no endpoint)', () => {
		const html =
			`<ogygia-region live></ogygia-region>` +
			`<ogygia-region entry="/x.js" hydrate="load"></ogygia-region>` +
			regionTag(`render="defer" when="load"`); // no endpoint
		expect(find_streamable_regions(html)).toHaveLength(0);
	});

	test('dedupes repeated slots (same instance discovered twice while buffering)', () => {
		const tag = regionTag(`render="defer" when="load" endpoint="${ENDPOINT}"`);
		expect(find_streamable_regions(tag + tag)).toHaveLength(1);
	});

	test('a deferred CLIENT island (defer + hydrate) is streamable (phase 1)', () => {
		const html = regionTag(
			`render="defer" when="load" hydrate="load" entry="/x.js" endpoint="${ENDPOINT}"`
		);
		expect(find_streamable_regions(html)).toHaveLength(1);
	});
});

describe('build_parcel / done_parcel', () => {
	test('wraps rendered HTML in a slot-keyed template', () => {
		expect(build_parcel('SIG', '<p>hi</p>')).toBe(
			'<template data-ogygia-slot="SIG"><p>hi</p></template>'
		);
	});
	test('refuses HTML that would break out of the template box (falls back to fetch)', () => {
		expect(build_parcel('SIG', 'x</template><script>bad()</script>')).toBeNull();
	});
	test('done sentinel uses the reserved slot', () => {
		expect(done_parcel()).toBe(`<template data-ogygia-slot="${STREAM_DONE_SLOT}"></template>`);
	});
});
