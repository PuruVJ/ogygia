// server/html-scan.ts `region_css_tags` — what an isolated render (a held region's body) carries
// forward from its head: BOTH region-CSS forms, in order. Keeping `<link>` only (region_css_links)
// silently unstyled every sheet small enough for Kit's `inlineStyleThreshold`, which ogygia inlines
// as `<style data-ogygia-region-css="href">`.
import { describe, expect, it } from 'vitest';
import { region_css_tags } from '../src/server/html-scan.ts';

describe('region_css_tags', () => {
	it('keeps both forms in head order; drops everything else', () => {
		const head =
			'<script type="module" data-ogygia-runtime src="/r.js"></script>' +
			'<link rel="stylesheet" href="/a.css" data-ogygia-region-css>' +
			'<link rel="modulepreload" href="/x.js">' +
			'<style data-ogygia-region-css="/b.css">.b.svelte-1{color:red}</style>' +
			'<style>.unrelated{}</style>' +
			'<meta name="ogygia-kit-island" content="/e.js">' +
			'<link rel="stylesheet" data-ogygia-region-css href="/c.css">';
		expect(region_css_tags(head)).toBe(
			'<link rel="stylesheet" href="/a.css" data-ogygia-region-css>' +
				'<style data-ogygia-region-css="/b.css">.b.svelte-1{color:red}</style>' +
				'<link rel="stylesheet" data-ogygia-region-css href="/c.css">'
		);
	});

	it('an empty or CSS-free head yields nothing; lookalike tags are not region CSS', () => {
		expect(region_css_tags('')).toBe('');
		expect(region_css_tags('<link rel="stylesheet" href="/a.css"><style>.a{}</style>')).toBe('');
		expect(region_css_tags('<linker data-ogygia-region-css><styles data-ogygia-region-css>')).toBe(
			''
		);
	});

	it('an unterminated inline sheet stops the scan instead of swallowing the rest', () => {
		expect(
			region_css_tags(
				'<link href="/a.css" data-ogygia-region-css><style data-ogygia-region-css="/b.css">.b{'
			)
		).toBe('<link href="/a.css" data-ogygia-region-css>');
	});
});
