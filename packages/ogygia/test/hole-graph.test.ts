// A hole's answer carries the island graph its islands wrote into the render's head, as ONE script
// with root-absolute URLs (the answer lands in a page at any depth).
import { expect, test } from 'vitest';
import { hole_graph_script } from '../src/server/hole-graph.js';
import { island_graph_script } from '../src/server/document-tail.js';
import { decode_island_graph, decode_island_locations } from '../src/island-graph.js';

const base = new URL('https://a.test/__ogygia__?id=x');

test('the head graph scripts merge into one, their URLs root-absolute', () => {
	const head =
		'<link rel="stylesheet" href="./x.css">' +
		island_graph_script(new Map([['./_app/immutable/a.js', ['./_app/immutable/c1.js', './_app/immutable/c2.js']]]), new Map([['./_app/immutable/a.js', './_app/immutable/a.123.js']])) +
		island_graph_script(new Map([['./_app/immutable/b.js', ['/_app/immutable/c1.js']]]));
	const out = hole_graph_script(head, base);
	const text = out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script'));
	expect(Object.fromEntries(decode_island_graph(text))).toEqual({
		'/_app/immutable/a.js': ['/_app/immutable/c1.js', '/_app/immutable/c2.js'],
		'/_app/immutable/b.js': ['/_app/immutable/c1.js']
	});
	expect(Object.fromEntries(decode_island_locations(text))).toEqual({ '/_app/immutable/a.js': '/_app/immutable/a.123.js' });
});

test('no graph in the head: nothing added', () => {
	expect(hole_graph_script('<title>x</title>', base)).toBe('');
});
