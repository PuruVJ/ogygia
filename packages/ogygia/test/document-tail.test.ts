/**
 * THE DOCUMENT TAIL (server/document-tail.ts) — what a Kit page render defers to the end of the
 * body: its island graph (one list per entry), then every island's props sidecar
 * (one per fingerprint). Region.svelte writes to it only inside Kit's page pass with a tail
 * installed; every other render root keeps hints in the head and the sidecar adjacent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';
import KitPagePass from './_fixtures/KitPagePass.svelte';
import { DocumentTail, set_tail_reader, document_tail, props_preview } from '../src/server/document-tail.js';
import { decode_island_graph } from '../src/island-graph.js';
import { set_island_deps } from './_stubs/virtual-island-deps.js';

const region = Region as unknown as Component<Record<string, unknown>>;
const kit_pass = KitPagePass as unknown as Component<Record<string, unknown>>;

const SIDECAR_G = /<script type="application\/ogygia-props" data-ogygia-props="([0-9a-f]+)"[^>]*>([^<]*)<\/script>/g;
const FP_ATTR_G = /data-og-fp="([0-9a-f]+)"/g;
const GRAPH_SCRIPT_RE = /<script type="application\/json" data-ogygia-graph>([^<]*)<\/script>/;

const island = (props: Record<string, unknown> = {}, entry = '/islands/tiny.js') => ({
	__mode: 'island',
	__entry: entry,
	__component: Tiny,
	__props: props,
	load: true
});

/** Render islands inside the Kit page-pass stand-in (snippet children of KitPagePass). */
function render_in_kit_pass(list: Array<Record<string, unknown>>) {
	const children = (renderer: { push(html: string): void }) => {
		for (const props of list) (region as unknown as (r: unknown, p: unknown) => void)(renderer, props);
	};
	return render(kit_pass, { props: { children } });
}

let tail: DocumentTail;
function install_tail() {
	tail = new DocumentTail();
	set_tail_reader(() => tail);
}
afterEach(() => set_tail_reader(null));

describe('DocumentTail', () => {
	it('hints dedupe per href (first wins), props dedupe per fingerprint, render is hints then props', () => {
		const t = new DocumentTail();
		expect(t.empty).toBe(true);
		t.hints(['/a.js', '/b.js']);
		t.hints(['/b.js', '/c.js']);
		const wire = (text: string) => ({ wire: () => ({ text, json: false }) });
		t.props('f1', wire('1'), { entry: '/islands/one.js', name: 'One', module_url: '/one.js', wake: 'load' });
		t.props('f1', wire('DUPLICATE'));
		t.props('f2', wire('2'));
		t.hints(['/one.js'], 'f1');
		expect(t.size).toEqual({ hints: 4, graph: 0, props: 2, holes: 0 });
		expect(t.empty).toBe(false);
		expect(t.render()).toBe(
			'<link rel="modulepreload" href="/a.js" fetchpriority="low">' +
				'<link rel="modulepreload" href="/b.js" fetchpriority="low">' +
				'<link rel="modulepreload" href="/c.js" fetchpriority="low">' +
				'<link rel="modulepreload" href="/one.js" fetchpriority="low">' +
				'<script type="application/ogygia-props" data-ogygia-props="f1" id="og-props-f1">1</script>' +
				'<script type="application/ogygia-props" data-ogygia-props="f2" id="og-props-f2">2</script>'
		);
		// no detail asked: no rows; with detail, one row per fingerprint with the count + the meta
		expect(t.island_rows()).toBeNull();
		t.render(null, true);
		expect(t.island_rows()).toMatchObject([
			{ fp: 'f1', entry: '/islands/one.js', name: 'One', wake: 'load', count: 2, props_bytes: 1, json: false, hints: ['/one.js'] },
			{ fp: 'f2', entry: '', name: '', count: 1 }
		]);
	});

	it('an empty hint list adds nothing; the tag is built once at render, never parsed from markup', () => {
		const t = new DocumentTail();
		t.hints([]);
		expect(t.size.hints).toBe(0);
		expect(t.render()).toBe('');
		t.hints(['/only.js']);
		expect(t.render()).toBe('<link rel="modulepreload" href="/only.js" fetchpriority="low">');
	});

	// THE HOLES RECORD: a Kit-hydrated document's deferred holes, by identity, so a hole Kit renders
	// again after giving up on the document gets its server-minted address back (runtime/hole-facts).
	it('hole() records endpoint + sidecar per identity (first wins), rendered last as ONE escaped JSON script', () => {
		const t = new DocumentTail();
		t.hole('aaaaaaaaaaaaaaaa', '/__ogygia__?id=a&props=W3t9XQ&exp=1&sig=s', '');
		t.hole('aaaaaaaaaaaaaaaa', '/__ogygia__?id=DUPLICATE', '');
		t.hole('bbbbbbbbbbbbbbbb', '/__ogygia__?id=b&props=W3t9XQ&exp=1&sig=s', '<script type="application/ogygia-props" data-ogygia-props>[{"n":1},1]</script>');
		t.hole('', '/__ogygia__?id=no-identity', ''); // no identity → nothing to key on
		t.hole('cccccccccccccccc', '', ''); // no address → nothing worth recording
		t.props('f1', { wire: () => ({ text: '1', json: false }) });
		// the profiler's hole notes: every document, keyed by schedule + policy, counted
		t.note_hole('cafebabe0101', 'load', null, 0, 'Recs', { forProduct: 'P0' });
		t.note_hole('cafebabe0101', 'load', null, 0, 'Recs', { forProduct: 'P0' });
		t.note_hole('cafebabe0102', 'visible', 'load', 60);
		expect(t.hole_rows()).toEqual([
			{ id: 'cafebabe0101', name: 'Recs', props: '{"forProduct":"P0"}', when: 'load', hydrate: null, ttl: 0, count: 2 },
			{ id: 'cafebabe0102', name: '', props: '', when: 'visible', hydrate: 'load', ttl: 60, count: 1 }
		]);
		// the preview: empty for nothing, safe on a cycle, truncated past 80 chars
		expect(props_preview({})).toBe('');
		expect(props_preview(null)).toBe('');
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(props_preview(cyc)).toBe('');
		expect(props_preview({ s: 'x'.repeat(200) })).toHaveLength(80);
		expect(t.size).toEqual({ hints: 0, graph: 0, props: 1, holes: 2 });
		expect(t.empty).toBe(false);
		const html = t.render();
		// after the props sidecars, one script, `<` escaped so the sidecar HTML inside cannot close it
		expect(html.indexOf('data-ogygia-props="f1"')).toBeLessThan(html.indexOf('application/ogygia-holes'));
		const m = /<script type="application\/ogygia-holes" data-ogygia-holes>(.*)<\/script>$/.exec(html);
		expect(m).not.toBeNull();
		expect(m![1]).not.toContain('<');
		expect(JSON.parse(m![1])).toEqual({
			aaaaaaaaaaaaaaaa: { endpoint: '/__ogygia__?id=a&props=W3t9XQ&exp=1&sig=s', sidecar: '' },
			bbbbbbbbbbbbbbbb: {
				endpoint: '/__ogygia__?id=b&props=W3t9XQ&exp=1&sig=s',
				sidecar: '<script type="application/ogygia-props" data-ogygia-props>[{"n":1},1]</script>'
			}
		});
	});

	it('a tail with only holes is not empty; one with none renders no record script', () => {
		const t = new DocumentTail();
		expect(t.render()).not.toContain('ogygia-holes');
		t.hole('dddddddddddddddd', '/__ogygia__?id=d', '');
		expect(t.empty).toBe(false);
		expect(t.render()).toContain('<script type="application/ogygia-holes" data-ogygia-holes>');
	});

	it('document_tail() is null until a reader is installed', () => {
		expect(document_tail()).toBeNull();
		install_tail();
		expect(document_tail()).toBe(tail);
	});
});

describe('Region.svelte × the tail', () => {
	// The islands' chunk closures: a placed island's graph is data (island-graph.ts), never a hint.
	beforeEach(() => set_island_deps({ '/islands/tiny.js': ['/chunks/svelte.js'], '/islands/hole.js': ['/chunks/svelte.js'] }));
	afterEach(() => set_island_deps({}));
	const graph_of = (html: string) => decode_island_graph(GRAPH_SCRIPT_RE.exec(html)?.[1] ?? '{}');

	it('no tail (a test / standalone render): graph in the head, sidecar adjacent and keyed', () => {
		const out = render(region, { props: island({ n: 1 }) });
		expect(out.head).not.toContain('modulepreload');
		expect(graph_of(out.head)).toEqual(new Map([['/islands/tiny.js', ['/chunks/svelte.js']]]));
		const fps = [...out.body.matchAll(FP_ATTR_G)].map((m) => m[1]);
		const sidecars = [...out.body.matchAll(SIDECAR_G)];
		expect(fps).toHaveLength(1);
		expect(sidecars).toHaveLength(1);
		expect(sidecars[0][1]).toBe(fps[0]);
		expect(out.body.indexOf('</ogygia-region>')).toBeLessThan(out.body.indexOf('<script type="application/ogygia-props"'));
	});

	it('tail installed but NOT a Kit page pass (an ogygia render root): head + adjacent, tail untouched', () => {
		install_tail();
		const out = render(region, { props: island({ n: 1 }) });
		expect(graph_of(out.head).size).toBe(1);
		expect([...out.body.matchAll(SIDECAR_G)]).toHaveLength(1);
		expect(tail.empty).toBe(true);
	});

	it('Kit page pass + tail: graph and sidecar go to the tail, nothing in the head or inline', () => {
		install_tail();
		const out = render_in_kit_pass([island({ n: 1 })]);
		expect(out.head).not.toContain('modulepreload');
		expect(out.head).not.toContain('data-ogygia-graph');
		expect(out.body).not.toContain('data-ogygia-props');
		const fps = [...out.body.matchAll(FP_ATTR_G)].map((m) => m[1]);
		expect(fps).toHaveLength(1);
		expect(tail.size).toEqual({ hints: 0, graph: 1, props: 1, holes: 0 });
		const html = tail.render();
		// keyed twice: `data-ogygia-props` for the reconciler, `id` for the runtime's O(1) lookup
		expect(html).toContain(`<script type="application/ogygia-props" data-ogygia-props="${fps[0]}" id="og-props-${fps[0]}"`);
		expect(html).not.toContain('modulepreload');
		expect(graph_of(html)).toEqual(new Map([['/islands/tiny.js', ['/chunks/svelte.js']]]));
		// the profiler's closure for the island: its entry, then its chunks
		tail.render(null, true);
		expect(tail.island_rows()![0].hints).toEqual(['/islands/tiny.js', '/chunks/svelte.js']);
	});

	it('three islands: identical ones share a sidecar, the shared entry is listed once', () => {
		install_tail();
		const out = render_in_kit_pass([island({ n: 1 }), island({ n: 1 }), island({ n: 2 })]);
		const fps = [...out.body.matchAll(FP_ATTR_G)].map((m) => m[1]);
		expect(fps).toHaveLength(3);
		expect(new Set(fps).size).toBe(2);
		expect(tail.size).toEqual({ hints: 0, graph: 1, props: 2, holes: 0 });
	});

	it('a server island that hydrates: its graph rides the tail, its FETCH preload stays in the head', () => {
		install_tail();
		const hole = {
			__mode: 'server',
			__entry: 'hole-1',
			__component: Tiny,
			__props: {},
			__defer: 'load',
			__hydrate: 'load',
			__module: '/islands/hole.js'
		};
		const out = render_in_kit_pass([hole]);
		expect(out.head).not.toContain('modulepreload');
		// (the fetch preload needs a minted endpoint — the unit stub mints none; e2e/server-islands
		// asserts it stays in the head on a real page)
		expect(tail.size.graph).toBe(1);
		expect(graph_of(tail.render())).toEqual(new Map([['/islands/hole.js', ['/chunks/svelte.js']]]));
		// a hole's props sidecar is small and stays adjacent (only ISLAND sidecars move)
		expect(out.body).toContain('data-ogygia-props');
		expect(tail.size.props).toBe(0);
	});

	it('outside the page pass the same server island keeps its graph in the head', () => {
		install_tail();
		const out = render(region, {
			props: { __mode: 'server', __entry: 'hole-1', __component: Tiny, __props: {}, __defer: 'load', __hydrate: 'load', __module: '/islands/hole.js' }
		});
		expect(graph_of(out.head).size).toBe(1);
		expect(out.head).not.toContain('modulepreload');
		expect(tail.empty).toBe(true);
	});

	it('a visible island: its graph rides the tail like any wake (the runtime preloads it on wake)', () => {
		install_tail();
		const out = render_in_kit_pass([{ ...island({ n: 7 }), load: undefined, visible: true }]);
		expect(out.head).not.toContain('modulepreload');
		expect(tail.size).toEqual({ hints: 0, graph: 1, props: 1, holes: 0 });
	});
});
