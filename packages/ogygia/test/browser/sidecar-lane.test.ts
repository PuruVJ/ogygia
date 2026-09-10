// The wire the runtime READS, in a real browser: the keyed sidecar found by its id (and, for a
// document from before the id existed, by attribute), the JSON lane (`data-og-format="json"` on a
// sidecar or the seed → `JSON.parse`, nothing else), the csr fact read off `<meta name="ogygia-csr">`
// before any inline-script probe, and the shared IntersectionObserver.
import { beforeEach, expect, inject, test } from 'vitest';
import { page } from 'vitest/browser';
import { bootDev } from '../../src/runtime/full.js';
import { props_sidecar_of } from '../../src/runtime/sidecar.js';
import { parse_sidecar_text, prepare_spa_document } from '../../src/runtime/seeds.js';
import { KitBoot, kit_hydrates_page } from '../../src/runtime/kit-boot.js';
import { observe, observer_count, once_visible } from '../../src/runtime/observe.js';
import { page_state } from '../../src/shims/page-store.svelte.js';
import { runtime_session } from '../../src/runtime/session.js';

const HYDRATED = 'ogygia-region[data-hydrated]';
const decode = (
	key: 'counter_tail_ssr_b64' | 'counter_tail_legacy_ssr_b64' | 'counter_json_lane_ssr_b64'
) => decodeURIComponent(escape(atob(inject(key))));

beforeEach(() => {
	document.body.innerHTML = '';
	prepare_spa_document();
});

test('a keyed sidecar is found through the id map (id="og-props-<fp>")', () => {
	document.body.innerHTML = decode('counter_tail_ssr_b64');
	const region = document.querySelector('ogygia-region')!;
	const sidecar = props_sidecar_of(region)!;
	expect(sidecar.id).toBe('og-props-feedfacecafebeef');
	expect(sidecar).toBe(document.getElementById('og-props-feedfacecafebeef'));
	// the same lookup on a FOREIGN document (a navigation's parsed HTML) uses that document's id map
	const doc = new DOMParser().parseFromString(
		`<body>${decode('counter_tail_ssr_b64')}</body>`,
		'text/html'
	);
	const foreign = props_sidecar_of(doc.querySelector('ogygia-region')!)!;
	expect(foreign.ownerDocument).toBe(doc);
	expect(foreign.id).toBe('og-props-feedfacecafebeef');
});

test('a pre-id document (attribute only) still finds its keyed sidecar and hydrates', async () => {
	document.body.innerHTML = decode('counter_tail_legacy_ssr_b64');
	const region = document.querySelector('ogygia-region')!;
	const sidecar = props_sidecar_of(region)!;
	expect(sidecar.id).toBe('');
	expect(sidecar.getAttribute('data-ogygia-props')).toBe('feedfacecafebee0');
	bootDev();
	await expect
		.poll(() => document.querySelector(HYDRATED) !== null, { timeout: 10_000 })
		.toBe(true);
	await expect.element(page.getByTestId('count')).toHaveTextContent('3');
});

test('an adjacent (fingerprint-less) sidecar is the next sibling past <link> hints', () => {
	document.body.innerHTML =
		'<ogygia-region wake="load" entry="/x.js"></ogygia-region>' +
		'<link rel="modulepreload" href="/x.js">' +
		'<script type="application/ogygia-props" data-ogygia-props>{}</script>' +
		'<ogygia-region wake="load" entry="/y.js"></ogygia-region><p>no sidecar</p>';
	const [x, y] = document.querySelectorAll('ogygia-region');
	expect(props_sidecar_of(x)?.textContent).toBe('{}');
	expect(props_sidecar_of(y)).toBeNull();
});

test('parse_sidecar_text: the JSON lane is JSON.parse, everything else is devalue with revivers', () => {
	const json = document.createElement('script');
	json.setAttribute('data-og-format', 'json');
	json.textContent = '{"a":[1,2],"b":"<x>"}';
	expect(parse_sidecar_text(json)).toEqual({ a: [1, 2], b: '<x>' });
	const devalue = document.createElement('script');
	// devalue's flat form: a custom type is `["Tag", <index>]` — here the Map's value is Tag(7)
	devalue.textContent = '[{"m":1,"t":4},["Map",2,3],"k",["Tag",4],7]';
	const out = parse_sidecar_text(devalue, { Tag: (n: never) => (n as number) * 10 }) as {
		m: Map<string, number>;
		t: number;
	};
	expect(out.m).toBeInstanceOf(Map);
	expect(out.m.get('k')).toBe(70);
	expect(out.t).toBe(7);
	// the JSON lane never consults revivers — a "type tag" shape is plain data there
	json.textContent = '[["Tag",4]]';
	expect(parse_sidecar_text(json, { Tag: () => 'revived' as never })).toEqual([['Tag', 4]]);
});

test('JSON lane end to end: a json sidecar and a json seed hydrate the island and seed the store', async () => {
	document.body.innerHTML = decode('counter_json_lane_ssr_b64');
	expect(document.querySelector('script[data-ogygia-props]')!.getAttribute('data-og-format')).toBe(
		'json'
	);
	bootDev();
	await expect
		.poll(() => document.querySelector(HYDRATED) !== null, { timeout: 10_000 })
		.toBe(true);
	await expect.element(page.getByTestId('count')).toHaveTextContent('3');
	expect((page_state.data as { greeting: string }).greeting).toBe('json seed');
	await page.getByRole('button', { name: 'add' }).click();
	await expect.element(page.getByTestId('count')).toHaveTextContent('4');
});

test('the csr fact: the meta decides when present; the inline-script probe only when absent', () => {
	const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');
	expect(KitBoot.document_has(doc('<meta name="ogygia-csr" content="true">'))).toBe(true);
	// a stamped csr=false document says so even if a payload reflects the bootstrap text
	expect(
		KitBoot.document_has(
			doc('<meta name="ogygia-csr" content="false"><script>__sveltekit_x = 1</script>')
		)
	).toBe(false);
	expect(KitBoot.document_has(doc('<script>__sveltekit_abc = {}</script>'))).toBe(true);
	expect(
		KitBoot.document_has(doc('<script type="application/ogygia-page">__sveltekit_x =</script>'))
	).toBe(false);
	expect(KitBoot.document_has(doc('<p>plain</p>'))).toBe(false);

	// the live document: ONE probe, cached on the session until the next document
	document.head.querySelector('meta[name="ogygia-csr"]')?.remove();
	runtime_session.kit_page = undefined;
	expect(kit_hydrates_page()).toBe(false);
	const meta = document.createElement('meta');
	meta.name = 'ogygia-csr';
	meta.content = 'true';
	document.head.append(meta);
	expect(kit_hydrates_page()).toBe(false); // cached — nobody re-reads the document
	runtime_session.kit_page = undefined; // the router's prepare, on the next document
	expect(kit_hydrates_page()).toBe(true);
	meta.remove();
	runtime_session.kit_page = undefined;
});

test('one IntersectionObserver per rootMargin, shared by every element; once_visible fires once', async () => {
	document.body.innerHTML =
		'<div id="a" style="height:20px"></div><div id="b" style="height:20px"></div>' +
		'<div id="c" style="position:absolute;top:9000px;height:20px"></div>';
	const before = observer_count();
	const seen: string[] = [];
	const stop_a = observe(document.getElementById('a')!, '0px', (i) => seen.push('a:' + i));
	const stop_b = observe(document.getElementById('b')!, '0px', (i) => seen.push('b:' + i));
	expect(observer_count()).toBe(
		before + (before === 0 ? 1 : 0) || before + 1 - (before > 0 ? 1 : 0)
	);
	const with_zero = observer_count();
	observe(document.getElementById('c')!, '200px', (i) => seen.push('c:' + i));
	expect(observer_count()).toBe(with_zero + 1); // a distinct margin → one more observer
	observe(document.getElementById('c')!, '200px', (i) => seen.push('c2:' + i));
	expect(observer_count()).toBe(with_zero + 1); // same margin → shared (and the callback replaced)
	await expect
		.poll(() => seen.filter((s) => s.startsWith('a') || s.startsWith('b')).length)
		.toBe(2);
	expect(seen).toContain('a:true');
	expect(seen).toContain('b:true');
	expect(seen.some((s) => s === 'c:false')).toBe(false); // replaced before it reported
	expect(seen).toContain('c2:false');
	stop_a();
	stop_b();
	let fired = 0;
	once_visible(document.getElementById('a')!, '0px', () => fired++);
	await expect.poll(() => fired).toBe(1);
	document.getElementById('a')!.style.display = 'none';
	document.getElementById('a')!.style.display = '';
	await new Promise((r) => setTimeout(r, 100));
	expect(fired).toBe(1); // stopped after the first entry
});
