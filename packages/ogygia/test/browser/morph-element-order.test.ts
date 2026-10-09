// THE ELEMENT ORDERS ITS CHILDREN (runtime/ownership.ts facets, internal/notes/dom-ownership.md §11):
// under an upgraded custom element the morph matches by identity, never by position, morphs each match
// in place, and removes a leftover only when the RENDER made it.
//
// REGRESSION (field report on 6b927c3c): a hole's fallback rendered an empty panel inside an upgraded
// element whose runtime re-appended its element children at upgrade (the panel now after its closing
// block comment). The answer's full panel was inserted beside the stale empty one, which painted over
// it: a blank mega-menu panel for one user group.
import { afterEach, expect, test } from 'vitest';
import { parse_region_html } from '../../src/runtime/parse-html.js';
import { morph_children } from '../../src/runtime/morph.js';
import { mark_render_made, render_made } from '../../src/runtime/ownership.js';

// a design-system upgrade: re-appends its element children (comments stay behind), and adds a node
// of its own
customElements.define(
	'eo-relocating',
	class extends HTMLElement {
		connectedCallback() {
			for (const el of Array.from(this.children)) this.append(el);
			if (!this.querySelector(':scope > [data-own]')) {
				const own = document.createElement('span');
				own.setAttribute('data-own', '');
				this.append(own);
			}
		}
	}
);
customElements.define('eo-plain', class extends HTMLElement {});

const panel = (rows: number) =>
	`<!--[0--><section class="panel"><!--[-->${Array.from({ length: rows }, (_, i) => `<!--[0--><div id="row-${i + 1}">${i + 1}</div><!--]-->`).join('')}<!--]--></section><!--]-->`;
const nodes = (html: string) => Array.from(parse_region_html(html).childNodes);

let root: HTMLElement;
function mount(html: string): Element {
	root = document.createElement('div');
	document.body.append(root);
	root.innerHTML = html;
	return root.firstElementChild!;
}
afterEach(() => root?.remove());

for (const tag of ['eo-relocating', 'eo-plain']) {
	test(`${tag}: an empty fallback panel becomes the answer's full one — one panel, the same node`, () => {
		const host = mount(`<${tag}>${panel(0)}</${tag}>`);
		const old_panel = host.querySelector('section.panel');
		morph_children(root, nodes(`<${tag}>${panel(3)}</${tag}>`));
		const panels = root.querySelectorAll('section.panel');
		expect(panels.length).toBe(1);
		expect(panels[0]).toBe(old_panel); // morphed in place, not inserted
		expect(root.querySelectorAll('[id^=row-]').length).toBe(3);
	});
}

test('a byte-identical answer moves no node (nothing re-upgrades, nothing flickers)', () => {
	const host = mount(`<eo-relocating>${panel(2)}</eo-relocating>`);
	const before = Array.from(host.childNodes);
	morph_children(root, nodes(`<eo-relocating>${panel(2)}</eo-relocating>`));
	expect(Array.from(host.childNodes)).toEqual(before);
});

test('what the element made itself is kept; a render child the render stopped producing goes', () => {
	const host = mount(`<eo-relocating><aside data-promo>promo</aside>${panel(1)}</eo-relocating>`);
	// a first answer still renders the aside: from here on it is known render output
	morph_children(root, nodes(`<eo-relocating><aside data-promo>promo</aside>${panel(1)}</eo-relocating>`));
	expect(render_made(host.querySelector('aside')!, new Set())).toBe(true);
	// the next answer drops it (a different tag from anything it renders here)
	morph_children(root, nodes(`<eo-relocating>${panel(2)}</eo-relocating>`));
	expect(host.querySelector('aside')).toBeNull();
	expect(host.querySelectorAll(':scope > [data-own]').length).toBe(1); // the element's own node
	expect(host.querySelectorAll('section.panel').length).toBe(1);
});

test('unmarked, a leftover of a tag the render still produces is the render’s; of another tag, the element’s', () => {
	const host = mount(`<eo-relocating><section class="panel">a</section><section class="panel">b</section><em data-x>x</em></eo-relocating>`);
	morph_children(root, nodes(`<eo-relocating><section class="panel">one</section></eo-relocating>`));
	expect(host.querySelectorAll('section.panel').length).toBe(1);
	expect(host.querySelector('section.panel')!.textContent).toBe('one');
	expect(host.querySelector('[data-x]')).not.toBeNull(); // never rendered by this answer: not claimed as the render's
	// …until ogygia knows it placed it (a restore, an earlier morph): then the render may take it away
	mark_render_made(host.querySelector('[data-x]')!);
	morph_children(root, nodes(`<eo-relocating><section class="panel">one</section></eo-relocating>`));
	expect(host.querySelector('[data-x]')).toBeNull();
});

test('a stale region under an element is the render’s: removed (the old drop rule, now provenance)', () => {
	const host = mount(`<eo-relocating><ogygia-region data-old-hole></ogygia-region>${panel(1)}</eo-relocating>`);
	morph_children(root, nodes(`<eo-relocating>${panel(1)}</eo-relocating>`));
	expect(host.querySelector('[data-old-hole]')).toBeNull();
	expect(host.querySelector(':scope > [data-own]')).not.toBeNull();
});

test('a region that has not woken gets its re-minted address (its other attributes are the runtime’s)', () => {
	mount('<div><ogygia-region render="defer" endpoint="/__ogygia__?id=a&props=1" data-nested></ogygia-region></div>');
	morph_children(root, nodes('<div><ogygia-region render="defer" endpoint="/__ogygia__?id=a&props=2"></ogygia-region></div>'));
	const hole = root.querySelector('ogygia-region')!;
	expect(hole.getAttribute('endpoint')).toBe('/__ogygia__?id=a&props=2');
	expect(hole.hasAttribute('data-nested')).toBe(true);
});
