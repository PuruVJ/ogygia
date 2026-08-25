/**
 * `dedupe_modulepreload_links` — the handle's head pass that drops duplicate
 * `<link rel="modulepreload">` tags. Each island instance SSR-emits its own dep-hint block, so two
 * `load` islands sharing dep chunks (or one island rendered N times) repeat identical hints — a
 * real page carried ~44 duplicate tags. First occurrence wins; everything else in the head must
 * pass through byte-identical.
 */
import { describe, expect, it } from 'vitest';
import { dedupe_modulepreload_links } from '../src/server/head-presence.js';

const link = (href: string) => `<link rel="modulepreload" href="${href}">`;

describe('dedupe_modulepreload_links', () => {
	it('drops same-href duplicates, keeping the first', () => {
		const html = `<head>${link('/a.js')}${link('/b.js')}${link('/a.js')}${link('/a.js')}</head>`;
		expect(dedupe_modulepreload_links(html)).toBe(`<head>${link('/a.js')}${link('/b.js')}</head>`);
	});

	it('keeps distinct hrefs and non-modulepreload links untouched', () => {
		const css = '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/a.css">';
		const html = `<head>${css}${link('/a.js')}${link('/b.js')}</head>`;
		expect(dedupe_modulepreload_links(html)).toBe(html);
	});

	it('dedupes across interleaved per-island blocks (the real emission shape)', () => {
		// island 1: facade + shared deps; island 2: its facade + the SAME shared deps
		const html =
			link('/og-region.aaa.js') + link('/chunks/shared1.js') + link('/chunks/shared2.js') +
			link('/og-region.bbb.js') + link('/chunks/shared1.js') + link('/chunks/shared2.js') +
			'</head>';
		expect(dedupe_modulepreload_links(html)).toBe(
			link('/og-region.aaa.js') + link('/chunks/shared1.js') + link('/chunks/shared2.js') +
			link('/og-region.bbb.js') + '</head>'
		);
	});

	it('handles single-quoted attributes and attribute order variance', () => {
		const html =
			`<link href="/x.js" rel="modulepreload">` +
			`<link rel='modulepreload' href='/x.js'>` +
			'</head>';
		expect(dedupe_modulepreload_links(html)).toBe(`<link href="/x.js" rel="modulepreload"></head>`);
	});

	it('never matches an HTML-escaped (documented) tag in prose', () => {
		const doc = `<code>&lt;link rel="modulepreload" href="/a.js"&gt;</code>`;
		const html = `${doc}${link('/a.js')}${link('/a.js')}</head>`;
		expect(dedupe_modulepreload_links(html)).toBe(`${doc}${link('/a.js')}</head>`);
	});

	it('is a no-op when no hints are present (fast bail)', () => {
		const html = '<head><meta charset="utf-8"></head><body>modulepreload as text</body>';
		// contains the word but no tag — replace finds nothing, html unchanged
		expect(dedupe_modulepreload_links(html)).toBe(html);
	});
});
