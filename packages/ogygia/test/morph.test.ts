// Morph unit tests. Runs in vitest's `node` env against a tiny DOM shim (`./_stubs/dom.ts`) — the
// repo ships no jsdom/happy-dom on purpose. The shim import MUST come first: it installs
// `globalThis.Node` / `globalThis.document`, which `morph.ts` reads at module load.
import { describe, test, expect, beforeEach } from 'vitest';
import { document, el, frag, DomElement, NS_SVG } from './_stubs/dom.js';
import { morph_children, install } from '../src/runtime/morph.js';
import { slots } from '../src/runtime/slots.js';

beforeEach(() => {
	document._active = null;
});

/** Morph `parent`'s children toward the children described by `html`. Returns the same parent. */
function morph_to(parent: DomElement, html: string): DomElement {
	morph_children(parent, frag(html));
	return parent;
}

describe('install()', () => {
	test('fills the morph slot with the exported reconciler', () => {
		install();
		expect(slots.morph).toBe(morph_children);
	});
});

describe('text + comment nodes', () => {
	test('morphs text content in place (same text node identity)', () => {
		const p = el('<p>hello</p>');
		const t = p.firstChild;
		morph_children(p, frag('goodbye'));
		expect(p.textContent).toBe('goodbye');
		expect(p.firstChild).toBe(t); // reused, not replaced
	});

	test('no-op when text is unchanged', () => {
		const p = el('<p>same</p>');
		const t = p.firstChild;
		morph_children(p, frag('same'));
		expect(p.firstChild).toBe(t);
		expect(p.textContent).toBe('same');
	});

	test('morphs comment content in place', () => {
		const p = el('<div><!--old--></div>');
		const c = p.firstChild!;
		expect(c.nodeType).toBe(8);
		morph_children(p, frag('<!--new-->'));
		expect(p.firstChild).toBe(c);
		expect(p.firstChild!.nodeValue).toBe('new');
	});

	test('text node is not confused with a comment node (replace across kinds)', () => {
		const p = el('<div>text</div>');
		morph_children(p, frag('<!--c-->'));
		expect(p.firstChild!.nodeType).toBe(8);
		expect(p.firstChild!.nodeValue).toBe('c');
	});
});

describe('attributes', () => {
	test('adds new attributes', () => {
		const parent = el('<div><a>x</a></div>');
		const a = parent.firstChild as DomElement;
		morph_children(parent, frag('<a href="/y" title="t">x</a>'));
		expect(parent.firstChild).toBe(a);
		expect(a.getAttribute('href')).toBe('/y');
		expect(a.getAttribute('title')).toBe('t');
	});

	test('updates changed attribute values', () => {
		const parent = el('<div><a class="one">x</a></div>');
		const a = parent.firstChild as DomElement;
		morph_children(parent, frag('<a class="two">x</a>'));
		expect(a.getAttribute('class')).toBe('two');
	});

	test('removes attributes the new node dropped', () => {
		const parent = el('<div><a class="one" data-x="1">x</a></div>');
		const a = parent.firstChild as DomElement;
		morph_children(parent, frag('<a class="one">x</a>'));
		expect(a.getAttribute('class')).toBe('one');
		expect(a.hasAttribute('data-x')).toBe(false);
	});

	test('adds, updates, and removes in one pass', () => {
		const parent = el('<div><a class="a" keep="k" gone="g">x</a></div>');
		const a = parent.firstChild as DomElement;
		morph_children(parent, frag('<a class="b" keep="k" fresh="f">x</a>'));
		expect(a.getAttribute('class')).toBe('b'); // updated
		expect(a.getAttribute('keep')).toBe('k'); // untouched
		expect(a.getAttribute('fresh')).toBe('f'); // added
		expect(a.hasAttribute('gone')).toBe(false); // removed
	});

	test('boolean attribute added and removed', () => {
		const parent = el('<div><button>x</button></div>');
		const b = parent.firstChild as DomElement;
		morph_children(parent, frag('<button disabled>x</button>'));
		expect(b.hasAttribute('disabled')).toBe(true);
		morph_children(parent, frag('<button>x</button>'));
		expect(b.hasAttribute('disabled')).toBe(false);
	});
});

describe('element replace decision', () => {
	test('different tag → replace (new node identity)', () => {
		const parent = el('<div><span>hi</span></div>');
		const span = parent.firstChild;
		morph_children(parent, frag('<p>hi</p>'));
		expect((parent.firstChild as DomElement).tagName).toBe('P');
		expect(parent.firstChild).not.toBe(span);
		expect(parent.firstChild!.textContent).toBe('hi');
	});

	test('same tag → morph in place (kept identity)', () => {
		const parent = el('<div><span class="a">hi</span></div>');
		const span = parent.firstChild;
		morph_children(parent, frag('<span class="b">bye</span>'));
		expect(parent.firstChild).toBe(span);
		expect((span as DomElement).getAttribute('class')).toBe('b');
		expect(span!.textContent).toBe('bye');
	});
});

describe('keyed children (id / data-key)', () => {
	test('insert in the middle morphs neighbours in place', () => {
		const parent = el('<ul><li id="a">A</li><li id="c">C</li></ul>');
		const a = parent.children[0];
		const c = parent.children[1];
		morph_children(parent, frag('<li id="a">A</li><li id="b">B</li><li id="c">C</li>'));
		expect(parent.children.map((n) => n.getAttribute('id'))).toEqual(['a', 'b', 'c']);
		expect(parent.children[0]).toBe(a); // reused
		expect(parent.children[2]).toBe(c); // reused, not cascaded-replaced
	});

	test('remove from the middle keeps the survivors', () => {
		const parent = el('<ul><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>');
		const a = parent.children[0];
		const c = parent.children[2];
		morph_children(parent, frag('<li id="a">A</li><li id="c">C</li>'));
		expect(parent.children.map((n) => n.getAttribute('id'))).toEqual(['a', 'c']);
		expect(parent.children[0]).toBe(a);
		expect(parent.children[1]).toBe(c);
	});

	test('reorder morphs the SAME nodes into the new order (no replacement)', () => {
		const parent = el('<ul><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>');
		const a = parent.children[0];
		const b = parent.children[1];
		const c = parent.children[2];
		morph_children(parent, frag('<li id="c">C</li><li id="a">A</li><li id="b">B</li>'));
		expect(parent.children.map((n) => n.getAttribute('id'))).toEqual(['c', 'a', 'b']);
		expect(parent.children[0]).toBe(c);
		expect(parent.children[1]).toBe(a);
		expect(parent.children[2]).toBe(b);
	});

	test('reorder preserves per-node DOM state (typed-in input value)', () => {
		const parent = el(
			'<ul><li id="a"><input name="x"></li><li id="b"><input name="y"></li></ul>'
		);
		const inputA = parent.children[0].firstElementChild as DomElement;
		inputA.value = 'typed';
		morph_children(
			parent,
			frag('<li id="b"><input name="y"></li><li id="a"><input name="x"></li>')
		);
		expect(parent.children[0].getAttribute('id')).toBe('b');
		const movedA = parent.children[1].firstElementChild as DomElement;
		expect(movedA).toBe(inputA); // same node moved
		expect(movedA.value).toBe('typed'); // its state survived the reorder
	});

	test('data-key takes precedence over id', () => {
		const parent = el('<ul><li data-key="k1" id="x">1</li><li data-key="k2" id="y">2</li></ul>');
		const first = parent.children[0];
		morph_children(parent, frag('<li data-key="k2" id="y">2</li><li data-key="k1" id="x">1</li>'));
		expect(parent.children[0].getAttribute('data-key')).toBe('k2');
		expect(parent.children[1]).toBe(first); // k1 node reused in new slot
	});

	test('changing a keyed node key replaces it (old removed, new inserted)', () => {
		const parent = el('<ul><li id="a">A</li></ul>');
		const a = parent.children[0];
		morph_children(parent, frag('<li id="z">Z</li>'));
		expect(parent.children.length).toBe(1);
		expect(parent.children[0].getAttribute('id')).toBe('z');
		expect(parent.children[0]).not.toBe(a);
	});
});

describe('unkeyed children (positional)', () => {
	test('append new trailing children', () => {
		const parent = el('<div><span>1</span></div>');
		const s = parent.firstChild;
		morph_children(parent, frag('<span>1</span><span>2</span><span>3</span>'));
		expect(parent.children.length).toBe(3);
		expect(parent.children[0]).toBe(s);
		expect(parent.children.map((n) => n.textContent)).toEqual(['1', '2', '3']);
	});

	test('trim trailing children', () => {
		const parent = el('<div><span>1</span><span>2</span><span>3</span></div>');
		morph_children(parent, frag('<span>1</span>'));
		expect(parent.children.length).toBe(1);
		expect(parent.children[0].textContent).toBe('1');
	});

	test('positional text morph across a list', () => {
		const parent = el('<p>a<b>x</b>c</p>');
		morph_children(parent, frag('A<b>X</b>C'));
		expect(parent.textContent).toBe('AXC');
	});
});

describe('nested trees', () => {
	test('recurses and morphs deep text + attrs in place', () => {
		const parent = el(
			'<section><div class="card"><h2>Old</h2><p id="body">old body</p></div></section>'
		);
		const card = parent.firstChild as DomElement;
		const body = card.children[1];
		morph_children(
			parent,
			frag('<div class="card featured"><h2>New</h2><p id="body">new body</p></div>')
		);
		expect(parent.firstChild).toBe(card);
		expect(card.getAttribute('class')).toBe('card featured');
		expect(card.children[0].textContent).toBe('New');
		expect(body).toBe(card.children[1]); // kept by id
		expect(body.textContent).toBe('new body');
	});
});

describe('empty ↔ populated', () => {
	test('empty → populated', () => {
		const parent = el('<ul></ul>');
		expect(parent.children.length).toBe(0);
		morph_children(parent, frag('<li>1</li><li>2</li>'));
		expect(parent.children.map((n) => n.textContent)).toEqual(['1', '2']);
	});

	test('populated → empty', () => {
		const parent = el('<ul><li>1</li><li>2</li></ul>');
		morph_children(parent, []);
		expect(parent.children.length).toBe(0);
		expect(parent.firstChild).toBeNull();
	});
});

describe('form DOM properties', () => {
	test('syncs value on a NON-focused input (server is authoritative)', () => {
		const parent = el('<form><input name="q" value="old"></form>');
		const input = parent.firstElementChild as DomElement;
		expect(input.value).toBe('old');
		morph_children(parent, frag('<input name="q" value="new">'));
		expect(parent.firstElementChild).toBe(input); // same node
		expect(input.value).toBe('new'); // property followed the server
	});

	test('does NOT clobber value on the FOCUSED input (user is typing)', () => {
		const parent = el('<form><input name="q" value="server"></form>');
		const input = parent.firstElementChild as DomElement;
		input.value = 'user typing';
		input.focus();
		morph_children(parent, frag('<input name="q" value="server2">'));
		expect(input.value).toBe('user typing'); // preserved
		expect(document.activeElement).toBe(input); // focus preserved (node identity kept)
	});

	test('syncs checked property from the incoming attribute', () => {
		const parent = el('<form><input type="checkbox"></form>');
		const box = parent.firstElementChild as DomElement;
		expect(box.checked).toBe(false);
		morph_children(parent, frag('<input type="checkbox" checked>'));
		expect(box.checked).toBe(true);
		morph_children(parent, frag('<input type="checkbox">'));
		expect(box.checked).toBe(false);
	});

	test('does not clobber checked on the focused control', () => {
		const parent = el('<form><input type="checkbox"></form>');
		const box = parent.firstElementChild as DomElement;
		box.checked = true;
		box.focus();
		morph_children(parent, frag('<input type="checkbox">'));
		expect(box.checked).toBe(true); // user toggle preserved while focused
	});

	test('syncs option selected property', () => {
		const parent = el(
			'<form><select><option value="a">A</option><option value="b">B</option></select></form>'
		);
		const select = parent.firstElementChild as DomElement;
		const optB = select.children[1];
		morph_children(
			parent,
			frag('<select><option value="a">A</option><option value="b" selected>B</option></select>')
		);
		expect(optB.selected).toBe(true);
	});
});

describe('focus preservation', () => {
	test('focused element survives an attribute-only morph of a sibling subtree', () => {
		const parent = el('<div><input id="keep"><span class="a">x</span></div>');
		const input = parent.children[0];
		input.focus();
		morph_children(parent, frag('<input id="keep"><span class="b">y</span>'));
		expect(document.activeElement).toBe(input);
		expect(parent.children[1].getAttribute('class')).toBe('b');
	});
});

describe('SVG namespace', () => {
	test('creates inserted SVG children in the SVG namespace', () => {
		const parent = el('<div></div>');
		morph_children(parent, frag('<svg viewBox="0 0 10 10"><circle r="5"></circle></svg>'));
		const svg = parent.firstChild as DomElement;
		expect(svg.namespaceURI).toBe(NS_SVG);
		expect(svg.firstElementChild!.namespaceURI).toBe(NS_SVG);
		expect(svg.firstElementChild!.localName).toBe('circle');
	});

	test('morphs SVG attributes in place, keeping the node', () => {
		const parent = el('<div><svg><circle r="5"></circle></svg></div>');
		const svg = parent.firstChild as DomElement;
		const circle = svg.firstElementChild;
		morph_children(parent, frag('<svg><circle r="8" cx="1"></circle></svg>'));
		expect(parent.firstChild).toBe(svg);
		expect(svg.firstElementChild).toBe(circle);
		expect(circle!.getAttribute('r')).toBe('8');
		expect(circle!.getAttribute('cx')).toBe('1');
	});

	test('foreignObject switches its children back to the HTML namespace', () => {
		const parent = el('<div></div>');
		morph_children(parent, frag('<svg><foreignObject><div>hi</div></foreignObject></svg>'));
		const fo = (parent.firstChild as DomElement).firstElementChild!;
		expect(fo.namespaceURI).toBe(NS_SVG);
		expect(fo.firstElementChild!.namespaceURI).not.toBe(NS_SVG);
	});
});

describe('preserved / hydrated island subtrees', () => {
	test('a data-hydrated island root is never recursed into or replaced', () => {
		const parent = el(
			'<div><ogygia-island id="isl" data-hydrated><span class="live">rendered</span></ogygia-island></div>'
		);
		const island = parent.firstChild as DomElement;
		const inner = island.firstChild;
		// Server pushes a bare placeholder for the same island id.
		morph_children(parent, frag('<ogygia-island id="isl" data-hydrated></ogygia-island>'));
		expect(parent.firstChild).toBe(island); // kept
		expect(island.firstChild).toBe(inner); // subtree untouched (Svelte owns it)
		expect(island.textContent).toBe('rendered');
	});

	test('data-persist node kept intact across a morph', () => {
		const parent = el('<div><div id="p" data-persist><b>state</b></div></div>');
		const persist = parent.firstChild as DomElement;
		const b = persist.firstChild;
		morph_children(parent, frag('<div id="p" data-persist>replaced?</div>'));
		expect(parent.firstChild).toBe(persist);
		expect(persist.firstChild).toBe(b);
		expect(persist.textContent).toBe('state');
	});

	test('preserved island still repositions by key without being rebuilt', () => {
		const parent = el(
			'<div><p id="a">A</p><ogygia-island id="i" data-hydrated><i>x</i></ogygia-island></div>'
		);
		const island = parent.children[1];
		const inner = island.firstChild;
		morph_children(
			parent,
			frag('<ogygia-island id="i" data-hydrated></ogygia-island><p id="a">A</p>')
		);
		expect(parent.children[0]).toBe(island); // moved to front, same node
		expect(island.firstChild).toBe(inner); // still intact
	});
});
