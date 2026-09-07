// server/hole-urls.ts — a hole's HTML carries URLs Kit's `asset()` made relative to the ENDPOINT
// request (`/__ogygia__?…`); spliced into a page at `/docs/guides/` they 404. Found on a real
// site header: an interaction island inside a hole (`entry="./_app/immutable/og-region.…js"`) loaded
// from `/docs/guides/_app/…` and died on the first click.
import { describe, it, expect } from 'vitest';
import { absolutize_hole_html } from '../src/server/hole-urls.js';

const base = new URL('http://localhost/__ogygia__?id=abc&props=e30&exp=1&sig=s');

describe('absolutize_hole_html', () => {
	it('resolves a relative island entry against the endpoint URL → root-absolute', () => {
		const html =
			'<ogygia-region entry="./_app/immutable/og-region.1d43.js" wake="interaction"></ogygia-region>';
		expect(absolutize_hole_html(html, base)).toBe(
			'<ogygia-region entry="/_app/immutable/og-region.1d43.js" wake="interaction"></ogygia-region>'
		);
	});

	it('resolves a nested hole endpoint, keeping the attribute escaping of its query', () => {
		const html =
			'<ogygia-region render="defer" when="idle" endpoint="./__ogygia__?id=x&amp;props=e30&amp;exp=2&amp;sig=t"></ogygia-region>';
		expect(absolutize_hole_html(html, base)).toContain(
			'endpoint="/__ogygia__?id=x&amp;props=e30&amp;exp=2&amp;sig=t"'
		);
	});

	it('keeps Kit base when the endpoint lives under one', () => {
		const under_base = new URL('http://localhost/app/__ogygia__?id=abc');
		const html = '<ogygia-region entry="./_app/immutable/x.js"></ogygia-region>';
		expect(absolutize_hole_html(html, under_base)).toContain('entry="/app/_app/immutable/x.js"');
	});

	it('leaves absolute and foreign (federation) entries alone', () => {
		const html =
			'<ogygia-region entry="/_app/immutable/a.js"></ogygia-region>' +
			'<ogygia-region entry="https://cms.example.com/_app/immutable/b.js"></ogygia-region>';
		expect(absolutize_hole_html(html, base)).toBe(html);
	});

	it('rewrites region-css link hrefs and nothing else in the markup', () => {
		const html =
			'<link rel="stylesheet" href="./_app/immutable/assets/hole.css" data-ogygia-region-css>' +
			'<a href="./relative-link/">keep</a><img src="./img.png">';
		const out = absolutize_hole_html(html, base);
		expect(out).toContain('href="/_app/immutable/assets/hole.css" data-ogygia-region-css');
		expect(out).toContain('<a href="./relative-link/">keep</a><img src="./img.png">');
	});

	it('is a no-op for HTML without regions or region-css links', () => {
		const html = '<p>plain <a href="./x">x</a></p>';
		expect(absolutize_hole_html(html, base)).toBe(html);
	});
});
