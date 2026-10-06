/**
 * A held region's server render to HTML (`__renderHtml` of a region binding): the component's body,
 * prefixed with its island's stylesheet links and the region-CSS links its nested regions put in the
 * head — the page never imported a server-picked component, so its CSS is on no page stylesheet.
 * ONE copy for every island (the compiler used to inline this into each binding: hundreds of copies
 * of the same code in the server bundle, parsed at every cold start).
 */
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { islandCss } from 'virtual:ogygia/island-deps';
import { region_css_tags } from './html-scan.js';

const REGION_CSS_ATTR = 'data-ogygia-region-css';

export function render_region_html(component: Component<Record<string, unknown>>, module_url: string, props: Record<string, unknown>): string {
	const r = render(component, { props });
	let own = '';
	for (const href of islandCss(module_url)) own += '<link rel="stylesheet" href="' + href + '" ' + REGION_CSS_ATTR + '>';
	return own + region_css_tags(r.head) + r.body;
}
