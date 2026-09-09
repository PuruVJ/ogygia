/**
 * `dedupe_stylesheet_links` — the handle's head pass that drops duplicate `<link rel="stylesheet">`
 * tags. Kit links a route's client-graph CSS and Region.svelte links a rendered island's CSS from
 * the render pass; a layout island compiled as a real wrapper is in both, so one page carried 16
 * sheets twice. First occurrence wins; everything else passes through byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { dedupe_stylesheet_links } from '../src/server/head-presence.js';

const kit = (href: string) => `<link href="${href}" rel="stylesheet">`;
const og = (href: string) => `<link rel="stylesheet" href="${href}" data-ogygia-region-css>`;

describe('dedupe_stylesheet_links', () => {
	it('drops a Kit copy of a sheet the region pass already linked (Kit links after the rendered head)', () => {
		const html = `<head>${og('/a.css')}${og('/b.css')}${kit('/a.css')}${kit('/c.css')}</head>`;
		expect(dedupe_stylesheet_links(html)).toBe(
			`<head>${og('/a.css')}${og('/b.css')}${kit('/c.css')}</head>`
		);
	});

	it('drops a region copy when Kit linked first — whichever comes first wins', () => {
		const html = `<head>${kit('/a.css')}${og('/a.css')}</head>`;
		expect(dedupe_stylesheet_links(html)).toBe(`<head>${kit('/a.css')}</head>`);
	});

	it('leaves distinct hrefs, modulepreload links and <style> untouched', () => {
		const html =
			`<head>${kit('/a.css')}${og('/b.css')}<link rel="modulepreload" href="/x.js">` +
			`<link rel="modulepreload" href="/x.js"><style>.a{}</style></head>`;
		expect(dedupe_stylesheet_links(html)).toBe(html);
	});

	it('same href linked N times by N identical islands collapses to one', () => {
		const html = `<head>${og('/a.css')}${og('/a.css')}${og('/a.css')}</head>`;
		expect(dedupe_stylesheet_links(html)).toBe(`<head>${og('/a.css')}</head>`);
	});

	it('a link with no href is left alone', () => {
		const html = `<head><link rel="stylesheet"><link rel="stylesheet"></head>`;
		expect(dedupe_stylesheet_links(html)).toBe(html);
	});

	it('is a no-op on a document with no stylesheets (cheap probe)', () => {
		const html = `<head><title>x</title></head><body></body>`;
		expect(dedupe_stylesheet_links(html)).toBe(html);
	});
});
