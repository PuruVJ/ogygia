/**
 * INLINE REGION CSS at the render: under Kit's `inlineStyleThreshold` the build kept a region
 * sheet's text (`islandCssInline`), and every emitter of the region-CSS channel — Region.svelte for
 * an island's sheets, the handle for a hole answer's — turns it into
 * `<style data-ogygia-region-css="href">` instead of a blocking `<link>`. Same channel, same identity
 * (the href), two shapes. Sheets the build did not keep stay links.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';
import { region_css_tag } from '../src/server/region-css.js';
import { set_island_css, set_inline_css } from './_stubs/virtual-island-deps.js';
import { set_request_event_stub } from './_stubs/virtual-request-event.js';

const region = Region as unknown as Component<Record<string, unknown>>;
const ENTRY = '/islands/tiny.js';
const TINY_CSS = '/islands/tiny.css';
const BIG_CSS = '/islands/big.css';

/** ONE event per simulated request: the per-request CSS claim (`claim_region_css`) keys on it.
 *  `render()`'s `head` / `body` are LAZY getters — read them while the request is still installed,
 *  or the render runs off-request and claims nothing (no runtime script, no region CSS). */
function in_request(fn: () => { head: string; body: string }): { head: string; body: string } {
	const event = { route: { id: '/inline-css' } };
	set_request_event_stub(() => event);
	try {
		const out = fn();
		return { head: out.head, body: out.body };
	} finally {
		set_request_event_stub(null);
	}
}

afterEach(() => {
	set_island_css({});
	set_inline_css({});
	set_request_event_stub(null);
});

describe('region_css_tag', () => {
	it('inlines a kept sheet as <style> keyed by the resolved href, links the rest', () => {
		set_inline_css({ [TINY_CSS]: '.t{color:red}' });
		expect(region_css_tag(TINY_CSS, '/base' + TINY_CSS)).toBe(
			'<style data-ogygia-region-css="/base/islands/tiny.css">.t{color:red}</style>'
		);
		expect(region_css_tag(BIG_CSS, '/base' + BIG_CSS)).toBe(
			'<link rel="stylesheet" href="/base/islands/big.css" data-ogygia-region-css>'
		);
	});

	it('attribute-escapes the identity href in both shapes', () => {
		set_inline_css({ '/a.css': '.a{}' });
		expect(region_css_tag('/a.css', '/a.css?v="1"&x=<')).toContain('data-ogygia-region-css="/a.css?v=&quot;1&quot;&amp;x=&lt;"');
		expect(region_css_tag('/b.css', '/b.css?v="1"&x=<')).toContain('href="/b.css?v=&quot;1&quot;&amp;x=&lt;"');
	});
});

describe('Region.svelte × inline region css', () => {
	const island = () => ({ __mode: 'island', __entry: ENTRY, __component: Tiny, __props: { n: 1 }, load: true });

	it('an island whose sheet the build kept emits <style>; its other sheet stays a <link>', () => {
		set_island_css({ [ENTRY]: [TINY_CSS, BIG_CSS] });
		set_inline_css({ [TINY_CSS]: '.t{color:red}' });
		const out = in_request(() => render(region, { props: island() }));
		expect(out.head).toContain('<style data-ogygia-region-css="/islands/tiny.css">.t{color:red}</style>');
		expect(out.head).toContain('<link rel="stylesheet" href="/islands/big.css" data-ogygia-region-css>');
		expect(out.head).not.toContain('href="/islands/tiny.css"');
	});

	it('nothing kept (no threshold, pre-inline handoff): the links it always emitted', () => {
		set_island_css({ [ENTRY]: [TINY_CSS] });
		const out = in_request(() => render(region, { props: island() }));
		expect(out.head).toContain('<link rel="stylesheet" href="/islands/tiny.css" data-ogygia-region-css>');
		expect(out.head).not.toContain('<style data-ogygia-region-css');
	});
});
