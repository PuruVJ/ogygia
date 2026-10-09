/**
 * A held region's server render to HTML (`__renderHtml` of a region binding): the component's body,
 * prefixed with its island's stylesheet links and the region-CSS links its nested regions put in the
 * head — the page never imported a server-picked component, so its CSS is on no page stylesheet.
 * ONE copy for every island (the compiler used to inline this into each binding: hundreds of copies
 * of the same code in the server bundle, parsed at every cold start).
 *
 * A fresh render root: it sees the page of the render (server/render-page.ts) like every other root
 * ogygia starts — awaited first, so a region a remote call renders reads its page's `page.data`.
 */
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { islandCss } from 'virtual:ogygia/island-deps';
import { region_css_tags } from './html-scan.js';
import { kit_page_facts_tail, kit_page_ready, kit_render_context } from './kit-context.js';

const REGION_CSS_ATTR = 'data-ogygia-region-css';

export async function render_region_html(component: Component<Record<string, unknown>>, module_url: string, props: Record<string, unknown>): Promise<string> {
	await kit_page_ready();
	const r = await render(component, { props, context: kit_render_context() });
	let own = '';
	for (const href of islandCss(module_url)) own += '<link rel="stylesheet" href="' + href + '" ' + REGION_CSS_ATTR + '>';
	return own + region_css_tags(r.head) + r.body + kit_page_facts_tail();
}
