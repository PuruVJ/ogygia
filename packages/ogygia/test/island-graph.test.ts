/**
 * THE ISLAND GRAPH (src/island-graph.ts): a placed island's chunk closure rides the page as DATA —
 * one inert JSON script — never as `<link rel="modulepreload">` tags. The runtime preloads an
 * island's graph when it wakes (test/browser/island-graph-preload.test.ts); the HTML fetches
 * nothing on its own. Every wake gets its graph, the wakes the server cannot predict included.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { set_island_deps } from './_stubs/virtual-island-deps.js';
import { island_deps_module } from '../src/compiler/link/island-deps.js';
import { decode_island_graph, encode_island_graph } from '../src/island-graph.js';
import { DocumentTail, island_graph_script } from '../src/server/document-tail.js';
import { assert_no_legacy_options } from '../src/vite/options.js';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';

const region = Region as unknown as Component<Record<string, unknown>>;
const ENTRY = '/islands/tiny.js';
const DEPS = ['/chunks/svelte.js', '/chunks/shared.js'];
const MODULEPRELOAD_RE = /rel="modulepreload"/;
const GRAPH_SCRIPT_RE = /<script type="application\/json" data-ogygia-graph>([^<]*)<\/script>/;

afterEach(() => set_island_deps({}));

function render_island(wake: string) {
	const props: Record<string, unknown> = { __mode: 'island', __entry: ENTRY, __component: Tiny, __props: {} };
	if (wake.startsWith('(')) props.media = wake;
	else if (wake !== 'load') props[wake] = true;
	const out = render(region, { props });
	return out.head + out.body;
}

describe('island graph — encode / decode', () => {
	it('round-trips, naming each shared chunk once', () => {
		const graph = new Map([
			['/a.js', ['/svelte.js', '/x.js']],
			['/b.js', ['/svelte.js']]
		]);
		const text = encode_island_graph(graph);
		expect(text.split('/svelte.js').length - 1).toBe(1);
		expect(decode_island_graph(text)).toEqual(graph);
	});

	it('malformed text decodes to nothing, never throws', () => {
		expect(decode_island_graph('{').size).toBe(0);
		expect(decode_island_graph('{"h":1}').size).toBe(0);
	});

	it('the script cannot be broken out of', () => {
		const html = island_graph_script(new Map([['/a.js', ['/</script><x>.js']]]));
		expect(html.indexOf('</script>')).toBe(html.length - '</script>'.length);
		expect([...decode_island_graph(GRAPH_SCRIPT_RE.exec(html)![1]).values()][0]).toEqual(['/</script><x>.js']);
	});
});

describe('island graph — a placed island', () => {
	for (const wake of ['load', 'visible', 'idle', 'interaction', '(min-width: 600px)']) {
		it(`wake ${wake}: graph data, no modulepreload tag`, () => {
			set_island_deps({ [ENTRY]: DEPS });
			const html = render_island(wake);
			expect(MODULEPRELOAD_RE.test(html)).toBe(false);
			const m = GRAPH_SCRIPT_RE.exec(html);
			expect(m).not.toBeNull();
			expect(decode_island_graph(m![1]).get(ENTRY)).toEqual(DEPS);
		});
	}

	it('an island with no chunks of its own (dev) carries no graph script', () => {
		expect(GRAPH_SCRIPT_RE.test(render_island('load'))).toBe(false);
	});
});

describe('island graph — the document tail', () => {
	it('one script for the page, one list per entry (first wins)', () => {
		const tail = new DocumentTail();
		tail.graph('/a.js', ['/svelte.js', '/x.js']);
		tail.graph('/a.js', ['/other.js']);
		tail.graph('/b.js', ['/svelte.js']);
		const html = tail.render();
		expect(html.match(/data-ogygia-graph/g)?.length).toBe(1);
		expect(MODULEPRELOAD_RE.test(html)).toBe(false);
		expect(decode_island_graph(GRAPH_SCRIPT_RE.exec(html)![1])).toEqual(
			new Map([
				['/a.js', ['/svelte.js', '/x.js']],
				['/b.js', ['/svelte.js']]
			])
		);
		expect(tail.size.graph).toBe(2);
	});
});

describe('regions.preload is gone', () => {
	it('the key is a build error that says why', () => {
		expect(() => assert_no_legacy_options({ regions: { preload: 'all' } } as never)).toThrow(/regions\.preload/);
		expect(() => assert_no_legacy_options({ regions: {} })).not.toThrow();
	});

	it('the minted virtual module no longer exports a policy', () => {
		for (const [ssr, dev] of [
			[false, false],
			[true, true],
			[true, false]
		] as const)
			expect(island_deps_module(ssr, dev)).not.toContain('preloadPolicy');
	});
});
