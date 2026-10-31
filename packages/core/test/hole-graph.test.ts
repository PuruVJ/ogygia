// A hole's answer carries the island graph its islands wrote into the render's head, as ONE script
// with root-absolute URLs (the answer lands in a page at any depth).
import { expect, test } from 'vitest';
import { hole_graph_script, hole_head, head_region_css } from '../src/server/hole-graph.ts';
import { island_graph_script } from '../src/server/document-tail.ts';
import { decode_island_graph, decode_island_locations } from '../src/island-graph.ts';

const base = new URL('https://a.test/__ogygia__?id=x');

test('the head graph scripts merge into one, their URLs root-absolute', () => {
	const head =
		'<link rel="stylesheet" href="./x.css">' +
		island_graph_script(
			new Map([['./_app/immutable/a.js', ['./_app/immutable/c1.js', './_app/immutable/c2.js']]]),
			new Map([['./_app/immutable/a.js', './_app/immutable/a.123.js']])
		) +
		island_graph_script(new Map([['./_app/immutable/b.js', ['/_app/immutable/c1.js']]]));
	const out = hole_graph_script(head, base);
	const text = out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script'));
	expect(Object.fromEntries(decode_island_graph(text))).toEqual({
		'/_app/immutable/a.js': ['/_app/immutable/c1.js', '/_app/immutable/c2.js'],
		'/_app/immutable/b.js': ['/_app/immutable/c1.js']
	});
	expect(Object.fromEntries(decode_island_locations(text))).toEqual({
		'/_app/immutable/a.js': '/_app/immutable/a.123.js'
	});
});

test('no graph in the head: nothing added', () => {
	expect(hole_graph_script('<title>x</title>', base)).toBe('');
});

// REGRESSION (field report): an island inside a hole links its own chunk CSS into the render's head,
// and the endpoint shipped the body only — what the island rendered after the click (a flyout) had
// only the hole's own sheet, and arrived unstyled. Its region-CSS tags ride the answer now.
test('the head carries its islands’ region CSS too, as written, and nothing else', () => {
	const css_link =
		'<link rel="stylesheet" href="./_app/immutable/assets/og-region.A.css" data-ogygia-region-css>';
	const css_inline =
		'<style data-ogygia-region-css="./_app/immutable/assets/og-region.B.css">.b{color:red}</style>';
	const head =
		'<title>x</title><link rel="stylesheet" href="./page.css">' +
		css_link +
		island_graph_script(new Map([['./_app/immutable/a.js', ['./_app/immutable/c1.js']]])) +
		'<style>.page{}</style>' +
		css_inline;
	expect(head_region_css(head)).toBe(css_link + css_inline);
	const carried = hole_head(head, base);
	expect(carried.startsWith('<script')).toBe(true); // the graph first
	expect(carried.endsWith(css_link + css_inline)).toBe(true);
	expect(carried).not.toContain('page.css');
	expect(carried).not.toContain('.page{}');
	// (no endpoint URL to make the graph absolute against: the CSS alone)
	expect(hole_head(head, undefined)).toBe(css_link + css_inline);
});
