// DOM OWNERSHIP (runtime/ownership.ts, internal/notes/dom-ownership.md): every ogygia DOM writer asks
// the same question — who owns this element? — and obeys one table. The writers here: the pre-hydration
// drift check + repair (hydrate-core.ts), the morph in both targets (morph.ts), and drift-watch.
//
// REGRESSION (a field report, 2026-10-06): an island server-renders a third-party widget inside
// `{@html}` and marks it `data-ogygia-keep`; the widget upgrades before the island wakes and prepends
// a backdrop + appends a suggestions pane to its own light DOM. The repair recursed down to the widget
// and morphed IT as the morph root (whose ownership was never checked), stripping both nodes.
import { expect, test, afterEach } from 'vitest';
import { repair_if_drifted, sequence_differs } from '../../src/runtime/hydrate-core.js';
import { parse_region_html } from '../../src/runtime/parse-html.js';
import { install as install_morph, morph_children } from '../../src/runtime/morph.js';
import { link_boot } from '../../src/runtime/boot-link.js';
import { owner_of } from '../../src/runtime/ownership.js';
import { watch_region, unwatch_region, region_changed } from '../../src/runtime/drift-watch.js';

link_boot();
install_morph();

afterEach(() => {
	document.body.innerHTML = '';
});

let defined = 0;
/** A web component that, on upgrade, prepends P and appends Q to its own light DOM. */
function define_widget(): string {
	const name = `x-guided-${++defined}`;
	customElements.define(
		name,
		class extends HTMLElement {
			connectedCallback() {
				if (this.querySelector(':scope > .p')) return;
				this.prepend(Object.assign(document.createElement('div'), { className: 'p' }));
				this.append(Object.assign(document.createElement('div'), { className: 'q' }));
			}
		}
	);
	return name;
}

function region_of(html: string): HTMLElement {
	const region = document.createElement('div');
	region.innerHTML = html;
	document.body.appendChild(region);
	return region;
}
function want_of(html: string): Element {
	const w = parse_region_html(html).ownerDocument.createElement('ogygia-region');
	w.appendChild(parse_region_html(html));
	return w;
}

test('owner_of: declared foreign, region, slot, static, walk — one precedence', () => {
	const el = (html: string) => region_of(html).firstElementChild!;
	expect(owner_of(el('<div data-ogygia-keep="w"></div>'))).toBe('foreign');
	expect(owner_of(el('<div data-persist></div>'))).toBe('foreign');
	expect(owner_of(el('<ogygia-region data-ogygia-keep="nav"></ogygia-region>'))).toBe('region'); // a kept island, not foreign
	expect(owner_of(el('<ogygia-region data-hydrated></ogygia-region>'))).toBe('region');
	expect(owner_of(el('<ogygia-slot></ogygia-slot>'))).toBe('page');
	expect(owner_of(el('<div data-og-opaque></div>'))).toBe('static');
	expect(owner_of(el('<div></div>'))).toBe('walk');
	expect(owner_of(el('<div data-og-html><x-w></x-w></div>').firstElementChild!)).toBe('static');
});

for (const marker of ['data-og-opaque', 'data-ogygia-keep="search"']) {
	test(`the field case (${marker}): a widget that reworked its own light DOM before the wake is left alone`, () => {
		const name = define_widget();
		// the server sent the widget's children A, B; the island's own walked text sits around it
		const server = `<h2>Help</h2> <${name} ${marker}><form class="a"></form><i class="b"></i></${name}> <p>after</p>`;
		const region = region_of(server); // connecting it upgrades the widget: P … Q now in its light DOM
		const widget = region.querySelector(name)!;
		const [p, a, b, q] = Array.from(widget.children);
		expect([p, a, b, q].map((n) => n.className)).toEqual(['p', 'a', 'b', 'q']);
		// a walked sibling also drifted (whitespace stripped): the repair still has real work to do
		for (const n of Array.from(region.childNodes))
			if (n.nodeType === 3 && !n.textContent!.trim()) n.remove();

		const out = repair_if_drifted(region, server);
		expect(out.repaired).toBe(true); // the walked whitespace came back
		expect(out.conflict).toBeNull();
		// the widget kept every node, with its identity
		expect(Array.from(widget.children)).toEqual([p, a, b, q]);
		expect(region.querySelector(name)).toBe(widget);
		// and what Svelte's walk reads now matches the server
		expect(sequence_differs(region, want_of(server))).toBe(false);
	});
}

test('an {@html} beside walked content (data-og-html): the widget inside it is left alone, the parent level is repaired', () => {
	const name = define_widget();
	const server = `<div data-og-html><h3>Title</h3> <!----><${name}><form class="a"></form></${name}><!----></div>`;
	const region = region_of(server);
	const host = region.firstElementChild!;
	const widget = region.querySelector(name)!;
	const kids = Array.from(widget.children);
	expect(kids.map((n) => n.className)).toEqual(['p', 'a', 'q']);
	// whitespace between the heading and the {@html} block was stripped (the parent's own sequence)
	for (const n of Array.from(host.childNodes)) if (n.nodeType === 3) n.remove();
	const out = repair_if_drifted(region, server);
	expect(out.repaired).toBe(true);
	expect(out.conflict).toBeNull();
	expect(sequence_differs(region, want_of(server))).toBe(false);
	// the widget, whose own children changed, is untouched
	expect(Array.from(widget.children)).toEqual(kids);
});

test('a change only inside a widget Svelte never walks is not drift at all', () => {
	const name = define_widget();
	const server = `<${name} data-og-opaque><form></form></${name}>`;
	const region = region_of(server);
	expect(region.querySelector(name)!.children.length).toBe(3);
	expect(repair_if_drifted(region, server)).toEqual({
		repaired: false,
		reason: null,
		conflict: null
	});
});

test('slot content (host-page owned) is never compared or rewritten by the repair', () => {
	const server = '<p>x</p><ogygia-slot data-og-slot="s1"><b>host</b></ogygia-slot>';
	const region = region_of(server);
	const slot = region.querySelector('ogygia-slot')!;
	slot.append(document.createElement('em')); // host-page script edited it
	expect(repair_if_drifted(region, server).repaired).toBe(false);
	expect(slot.querySelector('em')).not.toBeNull();
});

test('a web component in a position Svelte WALKS: its added nodes go, and the conflict is named', () => {
	const name = define_widget();
	const server = `<${name}><span>{x}</span></${name}>`; // no stamp: Svelte walks these children
	const region = region_of(server);
	expect(region.querySelector(`${name} .p`)).not.toBeNull();
	const out = repair_if_drifted(region, server);
	expect(out.repaired).toBe(true);
	expect(region.querySelector(`${name} .p`)).toBeNull();
	expect(out.conflict).toContain(`<${name}>`);
	expect(out.conflict).toContain('{@html}');
	expect(sequence_differs(region, want_of(server))).toBe(false);
});

test('morph: a declared-foreign ROOT is a no-op, in both targets', () => {
	for (const target of ['live', 'walk'] as const) {
		const host = region_of(
			'<div data-ogygia-keep="w"><b>live</b><i>own</i></div>'
		).firstElementChild!;
		morph_children(host, Array.from(parse_region_html('<b>server</b>').childNodes), { target });
		expect(host.innerHTML).toBe('<b>live</b><i>own</i>');
	}
});

test('morph: a keyed match whose tag changed never replaces a kept element', () => {
	const parent = region_of('<section data-key="w" data-ogygia-keep="w"><b>live</b></section>');
	const kept = parent.firstElementChild!;
	morph_children(
		parent,
		Array.from(parse_region_html('<div data-key="w"><b>server</b></div>').childNodes)
	);
	expect(parent.firstElementChild).toBe(kept);
	expect(kept.innerHTML).toBe('<b>live</b>');
});

test('morph toward Svelte’s walk skips a stamped subtree; toward a live answer it patches it', () => {
	const walk = region_of('<div><span data-og-opaque><b>widget</b></span></div>').firstElementChild!;
	morph_children(
		walk,
		Array.from(parse_region_html('<span data-og-opaque><i>server</i></span>').childNodes),
		{ target: 'walk' }
	);
	expect(walk.innerHTML).toBe('<span data-og-opaque=""><b>widget</b></span>');
	const live = region_of('<div><span data-og-opaque><b>old</b></span></div>').firstElementChild!;
	morph_children(
		live,
		Array.from(parse_region_html('<span data-og-opaque><i>new</i></span>').childNodes)
	);
	expect(live.innerHTML).toBe('<span data-og-opaque=""><i>new</i></span>');
});

test('drift-watch: a widget editing inside an opaque subtree does not mark its island changed', async () => {
	const region = document.createElement('ogygia-region');
	region.innerHTML = '<p>t</p><div data-og-opaque><b>w</b></div>';
	document.body.appendChild(region);
	watch_region();
	try {
		region.querySelector('[data-og-opaque]')!.append(document.createElement('i'));
		expect(region_changed(region)).toBe(false);
		region.querySelector('p')!.append(document.createTextNode('!'));
		expect(region_changed(region)).toBe(true);
	} finally {
		unwatch_region();
	}
});
