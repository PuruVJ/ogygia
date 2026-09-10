// Browser-project globalSetup (runs in NODE, once): server-render the fixture islands exactly as a
// page would carry them — the component's SSR HTML inside an `<ogygia-region>` shell plus the
// devalue props sidecar — and hand the strings to the browser tests through `provide()`. The tests
// drop that HTML into the document and boot the real runtime, so what hydrates is the real island
// contract (attributes, sidecar, adoption), not a mounted component.
//
// Provided values ride into the browser inside an inline `<script>` of Vitest's orchestrator page.
// A literal `</script>` in the HTML (the props sidecar!) would close that script early and leave
// `window.__vitest_browser_runner__` unset — the "Failed to connect to the browser session" trap.
// So every HTML string is provided base64-encoded; `inject_html()` in the test decodes it.
import type { TestProject } from 'vitest/node';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { stringify } from 'devalue';
import Counter from './fixtures/Counter.svelte';
import Heavy from './fixtures/Heavy.svelte';
import LakeKitHost from './fixtures/LakeKitHost.svelte';
import { set_request_event_stub } from '../_stubs/virtual-request-event.js';
import { csr_true_routes } from '../_stubs/virtual-route-csr.js';

const COUNTER = '/test/browser/fixtures/Counter.svelte';
const HEAVY = '/test/browser/fixtures/Heavy.svelte';

/** The island shell a page carries: the runtime reads `wake` + `entry`, then the props sidecar. */
function island(entry: string, body: string, props: Record<string, unknown>, wake = 'load') {
	return (
		`<ogygia-region wake="${wake}" entry="${entry}">${body}</ogygia-region>` +
		`<script type="application/ogygia-props" data-ogygia-props>${stringify(props)}</script>`
	);
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

// The runtime hydrates a top-level island through NestedProvider (`{#if Component}<Component/>{/if}`),
// so a real region's SSR content is `<!--[0-->` (the if-branch) + `<!--[-->` (the dynamic component)
// + html + `<!--]--><!--]-->` — empirically `<!--[0--><!--[-->…` (see test/region-attrs.test.ts). The
// outermost envelope the runtime inserts itself at hydrate. `render()` gives us the component wrapped
// in ONE anchor pair, which stands in for the dynamic-component pair; add the if-branch pair around it.
const nested = (body: string) => `<!--[0-->${body}<!--]-->`;

/** A keyed sidecar as the server emits it: `id="og-props-<fp>"` (the id-map lookup) AND the
 *  `data-ogygia-props="<fp>"` attribute (the reconciler's key); `legacy` drops the id — a document
 *  from before the id was stamped, which the runtime still finds by attribute. */
function keyed_sidecar(fp: string, text: string, opts: { legacy?: boolean; json?: boolean } = {}) {
	const id = opts.legacy ? '' : ` id="og-props-${fp}"`;
	const format = opts.json ? ' data-og-format="json"' : '';
	return `<script type="application/ogygia-props"${id} data-ogygia-props="${fp}"${format}>${text}</script>`;
}

/** The page-pass shape: the region carries `data-og-fp`, its KEYED sidecar sits at the END of the
 *  body (after unrelated content), not next to the region — how the handle emits island props. */
function island_tail(
	entry: string,
	body: string,
	props: Record<string, unknown>,
	fp: string,
	legacy = false
) {
	return (
		`<ogygia-region wake="load" entry="${entry}" data-og-fp="${fp}">${body}</ogygia-region>` +
		`<p data-filler>content between the island and its props</p>` +
		keyed_sidecar(fp, stringify(props), { legacy })
	);
}

/** The seed script as the handle emits it (devalue), or on the JSON lane (`data-og-format="json"`). */
function seed_script(seed: Record<string, unknown>, json = false) {
	const text = json ? JSON.stringify(seed) : stringify(seed);
	return `<script type="application/ogygia-page" data-ogygia-page${json ? ' data-og-format="json"' : ''}>${text}</script>`;
}

/** SEED REFERENCES: the region's props sidecar is ONE reference into the page seed (the whole
 *  props object is a seed node), and the seed script sits at the end of the body — the page-pass
 *  shape once an island's props come from `page.data`. */
function island_seed_ref(
	entry: string,
	body: string,
	seed_data: Record<string, unknown>,
	path: string[],
	fp: string
) {
	// The props root itself is the seed node: devalue writes it as `["OgygiaSeedRef", <path>]` —
	// produced by the real encoder (a hand-written form is easy to get wrong: devalue arrays hold
	// INDICES, so a literal string inside one reads as a type tag).
	const root = {};
	const props_text = stringify(root, {
		OgygiaSeedRef: (v: unknown) => (v === root ? path : undefined)
	});
	return (
		`<ogygia-region wake="load" entry="${entry}" data-og-fp="${fp}">${body}</ogygia-region>` +
		`<p data-filler>content</p>` +
		keyed_sidecar(fp, props_text) +
		seed_script({
			url: 'http://localhost/',
			params: {},
			route: { id: '/' },
			status: 200,
			data: seed_data
		})
	);
}

/** A whole navigable document (for `DOMParser` on the test side): a seed-ref island whose seed
 *  carries `counter.start = start`, under its own fingerprint — page A and page B of a nav. */
function seed_nav_document(body: string, start: number, fp: string) {
	return (
		`<!doctype html><html><head><meta name="ogygia-router" content="plain"><title>page ${start}</title></head><body>` +
		`<h1 data-page-title>page ${start}</h1>` +
		island_seed_ref(COUNTER, body, { counter: { start } }, ['counter'], fp) +
		`</body></html>`
	);
}

declare module 'vitest' {
	export interface ProvidedContext {
		/** Counter whose props sidecar is a seed REFERENCE (`["OgygiaSeedRef", ["counter"]]`) and
		 *  whose page seed carries `data.counter = { start: 3, … }` — base64. */
		counter_seedref_ssr_b64: string;
		/** A `wake: 'load'` Counter island, SSR'd with `start: 3` — base64 of the HTML. */
		counter_ssr_b64: string;
		/** The same Counter with its props sidecar KEYED (id + attribute) at the end of the body. */
		counter_tail_ssr_b64: string;
		/** The keyed shape from before the server stamped the id: attribute only. */
		counter_tail_legacy_ssr_b64: string;
		/** JSON LANE: a seed-ref Counter whose sidecar and seed are both `data-og-format="json"`. */
		counter_json_lane_ssr_b64: string;
		/** LakeKitHost SSR'd on a csr=true document (a lake wrapping a Counter island) — base64. */
		lake_kit_ssr_b64: string;
		/** HYDRATION SCHEDULE: 21 expensive `wake:'load'` islands, 18 below the fold FIRST in document
		 *  order, then 3 in the viewport — base64. */
		heavy_schedule_ssr_b64: string;
		/** Two whole documents of a navigation: seed-ref Counter, `start` 3 then 7 — base64 each. */
		seed_nav_a_html_b64: string;
		seed_nav_b_html_b64: string;
	}
}

/** SSR `comp` inside a request for a csr=true route, so Region takes its Kit-hydrated paths.
 *  `render()`'s body is a LAZY getter (the component runs on first read) — read it in here. */
function render_on_kit_page(comp: Component): string {
	set_request_event_stub(() => ({ route: { id: '/kit' } }));
	csr_true_routes.add('/kit');
	try {
		return render(comp).body;
	} finally {
		csr_true_routes.delete('/kit');
		set_request_event_stub(null);
	}
}

export default function setup(project: TestProject) {
	const props = { start: 3 };
	const { body } = render(Counter, { props });
	// Root-relative: the browser project's Vite server serves the package root, and the svelte plugin
	// compiles the `.svelte` on import — a real `import(entry)` through `island_module_url`.
	project.provide('counter_ssr_b64', b64(island(COUNTER, nested(body), props)));
	project.provide(
		'counter_seedref_ssr_b64',
		b64(
			island_seed_ref(
				COUNTER,
				nested(body),
				{ counter: { start: 3, pad: 'seed data the island does not read '.repeat(4) } },
				['counter'],
				'0123456789abcdef'
			)
		)
	);
	project.provide(
		'counter_tail_ssr_b64',
		b64(island_tail(COUNTER, nested(body), props, 'feedfacecafebeef'))
	);
	project.provide(
		'counter_tail_legacy_ssr_b64',
		b64(island_tail(COUNTER, nested(body), props, 'feedfacecafebee0', true))
	);
	// JSON lane: the sidecar is plain JSON with a seed reference written the JSON way? No — a seed
	// reference needs devalue's type tag, so the JSON lane carries PLAIN props (`{ start: 3 }`) and a
	// plain JSON seed; both parse with `JSON.parse`.
	project.provide(
		'counter_json_lane_ssr_b64',
		b64(
			`<ogygia-region wake="load" entry="${COUNTER}" data-og-fp="0000aaaa1111bbbb">${nested(body)}</ogygia-region>` +
				`<p data-filler>content</p>` +
				keyed_sidecar('0000aaaa1111bbbb', JSON.stringify(props), { json: true }) +
				seed_script(
					{
						url: 'http://localhost/',
						params: {},
						route: { id: '/' },
						status: 200,
						data: { greeting: 'json seed' }
					},
					true
				)
		)
	);
	// The real wrapper (Region.svelte) renders the lake + the island's shell here — the browser test
	// hydrates the same component over it, so both legs are the library's own code.
	project.provide('lake_kit_ssr_b64', b64(render_on_kit_page(LakeKitHost as unknown as Component)));

	// 21 heavy islands: 18 out of the viewport come FIRST in document order (absolutely positioned
	// far below), the 3 in-viewport ones LAST — so viewport-first and document-first disagree.
	const heavy = (n: number, top: number) =>
		`<div style="position:absolute;top:${top}px;left:0">` +
		island(HEAVY, nested(render(Heavy, { props: { n } }).body), { n }) +
		`</div>`;
	let schedule = '';
	for (let i = 0; i < 18; i++) schedule += heavy(i, 4000 + i * 40);
	for (let i = 18; i < 21; i++) schedule += heavy(i, (i - 18) * 40);
	project.provide('heavy_schedule_ssr_b64', b64(schedule));

	project.provide(
		'seed_nav_a_html_b64',
		b64(seed_nav_document(nested(body), 3, 'aaaaaaaaaaaaaaaa'))
	);
	project.provide(
		'seed_nav_b_html_b64',
		b64(
			seed_nav_document(
				nested(render(Counter, { props: { start: 7 } }).body),
				7,
				'bbbbbbbbbbbbbbbb'
			)
		)
	);
}
