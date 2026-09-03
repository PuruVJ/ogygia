/**
 * Tiny, faithful DOM shim for the morph unit tests.
 *
 * The ogygia repo runs vitest in the `node` environment on purpose (no jsdom/happy-dom dependency),
 * so there is no real DOM. `morph.ts` is pure DOM manipulation, so to unit-test it we stand up just
 * enough of the DOM: a doubly-linked child list, elements with attributes + namespaces, text/comment
 * nodes, `importNode`, `activeElement`/`focus`, and dirty-value/checked/selected form properties that
 * mirror the browser's "property vs attribute" split.
 *
 * Importing this module INSTALLS `globalThis.Node` and `globalThis.document` as a side effect, so it
 * MUST be imported before `morph.ts` (which reads `Node.ELEMENT_NODE` at module load).
 */

const NS_HTML = 'http://www.w3.org/1999/xhtml';
const NS_SVG = 'http://www.w3.org/2000/svg';

const VOID = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
]);
const FORMISH = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

type Attr = { name: string; value: string };

class DomNode {
	static readonly ELEMENT_NODE = 1;
	static readonly TEXT_NODE = 3;
	static readonly COMMENT_NODE = 8;
	static readonly DOCUMENT_FRAGMENT_NODE = 11;

	readonly ELEMENT_NODE = 1;
	readonly TEXT_NODE = 3;
	readonly COMMENT_NODE = 8;

	nodeType = 0;
	nodeValue: string | null = null;
	ownerDocument: DomDocument;

	_parent: DomNode | null = null;
	_prev: DomNode | null = null;
	_next: DomNode | null = null;
	_first: DomNode | null = null;
	_last: DomNode | null = null;

	constructor(doc: DomDocument | null) {
		// The document itself passes null and patches ownerDocument to itself.
		this.ownerDocument = doc as DomDocument;
	}

	get parentNode(): DomNode | null {
		return this._parent;
	}
	get firstChild(): DomNode | null {
		return this._first;
	}
	get lastChild(): DomNode | null {
		return this._last;
	}
	get nextSibling(): DomNode | null {
		return this._next;
	}
	get previousSibling(): DomNode | null {
		return this._prev;
	}

	get childNodes(): DomNode[] {
		const out: DomNode[] = [];
		for (let n = this._first; n; n = n._next) out.push(n);
		return out;
	}

	_detach(node: DomNode): void {
		const prev = node._prev;
		const next = node._next;
		if (prev) prev._next = next;
		else this._first = next;
		if (next) next._prev = prev;
		else this._last = prev;
		node._parent = node._prev = node._next = null;
	}

	insertBefore(node: DomNode, ref: DomNode | null): DomNode {
		if (node._parent) node._parent._detach(node);
		const prev = ref ? ref._prev : this._last;
		node._parent = this;
		node._prev = prev;
		node._next = ref;
		if (prev) prev._next = node;
		else this._first = node;
		if (ref) ref._prev = node;
		else this._last = node;
		return node;
	}

	appendChild(node: DomNode): DomNode {
		return this.insertBefore(node, null);
	}
	replaceChildren(...nodes: DomNode[]): void {
		while (this._first) this._detach(this._first);
		for (const n of nodes) this.appendChild(n);
	}
	removeChild(node: DomNode): DomNode {
		this._detach(node);
		return node;
	}

	replaceChild(next: DomNode, old: DomNode): DomNode {
		this.insertBefore(next, old);
		this._detach(old);
		return old;
	}

	replaceWith(next: DomNode): void {
		if (this._parent) this._parent.replaceChild(next, this);
	}

	get textContent(): string {
		if (this.nodeType !== 1) return this.nodeValue ?? '';
		let s = '';
		for (let n = this._first; n; n = n._next) s += n.textContent;
		return s;
	}
	set textContent(v: string) {
		while (this._first) this._detach(this._first);
		if (v !== '') this.appendChild(this.ownerDocument.createTextNode(v));
	}

	cloneNode(_deep?: boolean): DomNode {
		throw new Error('abstract');
	}
}

class DomText extends DomNode {
	constructor(doc: DomDocument, data: string, type = 3) {
		super(doc);
		this.nodeType = type;
		this.nodeValue = data;
	}
	cloneNode(): DomNode {
		return new DomText(this.ownerDocument, this.nodeValue ?? '', this.nodeType);
	}
}

class DomElement extends DomNode {
	namespaceURI: string;
	localName: string;
	tagName: string;
	_attrs: Attr[] = [];

	// Dirty form state — mirrors the browser's property-vs-attribute split.
	_value: string | null = null;
	_checked: boolean | null = null;
	_selected: boolean | null = null;

	constructor(doc: DomDocument, ns: string, localName: string, tagName: string) {
		super(doc);
		this.nodeType = 1;
		this.namespaceURI = ns;
		this.localName = localName;
		this.tagName = tagName;
	}

	get attributes(): Attr[] {
		return this._attrs;
	}

	getAttribute(name: string): string | null {
		const a = this._attrs.find((x) => x.name === name);
		return a ? a.value : null;
	}
	hasAttribute(name: string): boolean {
		return this._attrs.some((x) => x.name === name);
	}
	setAttribute(name: string, value: string): void {
		const a = this._attrs.find((x) => x.name === name);
		if (a) a.value = String(value);
		else this._attrs.push({ name, value: String(value) });
	}
	removeAttribute(name: string): void {
		const i = this._attrs.findIndex((x) => x.name === name);
		if (i >= 0) this._attrs.splice(i, 1);
	}

	get id(): string {
		return this.getAttribute('id') ?? '';
	}

	get children(): DomElement[] {
		const out: DomElement[] = [];
		for (let n = this._first; n; n = n._next) if (n.nodeType === 1) out.push(n as DomElement);
		return out;
	}
	get firstElementChild(): DomElement | null {
		for (let n = this._first; n; n = n._next) if (n.nodeType === 1) return n as DomElement;
		return null;
	}

	// --- form properties (only meaningful on form controls) ---
	get value(): string {
		if (this._value !== null) return this._value;
		if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent;
		if (this.tagName === 'SELECT') {
			for (const opt of this.querySelectorOptions()) if (opt.selected) return opt.value;
			const first = this.querySelectorOptions()[0];
			return first ? first.value : '';
		}
		return this.getAttribute('value') ?? '';
	}
	set value(v: string) {
		this._value = String(v);
	}

	get checked(): boolean {
		if (this._checked !== null) return this._checked;
		return this.hasAttribute('checked');
	}
	set checked(v: boolean) {
		this._checked = !!v;
	}

	get selected(): boolean {
		if (this._selected !== null) return this._selected;
		return this.hasAttribute('selected');
	}
	set selected(v: boolean) {
		this._selected = !!v;
	}

	/** Minimal selectors — a comma list of `tag`, `[attr]`, `tag[attr]` — what `morph.ts` needs. */
	querySelectorAll(selector: string): DomElement[] {
		const tests = selector.split(',').map((part) => {
			const m = part.trim().match(/^([a-zA-Z][\w-]*)?(?:\[([\w-]+)\])?$/);
			if (!m || (!m[1] && !m[2])) throw new Error('dom shim: unsupported selector ' + part);
			const tag = m[1] ? m[1].toUpperCase() : null;
			const attr = m[2] ?? null;
			return (e: DomElement) =>
				(tag === null || e.tagName === tag) && (attr === null || e.hasAttribute(attr));
		});
		const out: DomElement[] = [];
		const walk = (n: DomNode): void => {
			for (let c = n._first; c; c = c._next) {
				if (c.nodeType !== 1) continue;
				const e = c as DomElement;
				if (tests.some((t) => t(e))) out.push(e);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	private querySelectorOptions(): DomElement[] {
		const out: DomElement[] = [];
		const walk = (n: DomNode | null): void => {
			for (let c = n?._first ?? null; c; c = c._next) {
				if (c.nodeType === 1 && (c as DomElement).tagName === 'OPTION') out.push(c as DomElement);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	focus(): void {
		this.ownerDocument._active = this;
	}
	blur(): void {
		if (this.ownerDocument._active === this) this.ownerDocument._active = null;
	}

	cloneNode(deep?: boolean): DomNode {
		const copy = new DomElement(
			this.ownerDocument,
			this.namespaceURI,
			this.localName,
			this.tagName
		);
		copy._attrs = this._attrs.map((a) => ({ name: a.name, value: a.value }));
		// A clone reflects attributes, not dirty property state (matches the browser).
		if (deep) for (let n = this._first; n; n = n._next) copy.appendChild(n.cloneNode(true));
		return copy;
	}

	get outerHTML(): string {
		const attrs = this._attrs.map((a) => ` ${a.name}="${a.value}"`).join('');
		if (VOID.has(this.localName)) return `<${this.localName}${attrs}>`;
		return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
	}
	get innerHTML(): string {
		let s = '';
		for (let n = this._first; n; n = n._next) {
			if (n.nodeType === 1) s += (n as DomElement).outerHTML;
			else if (n.nodeType === 8) s += `<!--${n.nodeValue}-->`;
			else s += n.nodeValue;
		}
		return s;
	}
}

class DomDocument extends DomNode {
	_active: DomElement | null = null;

	constructor() {
		super(null);
		this.nodeType = 9;
		this.ownerDocument = this;
	}

	get activeElement(): DomElement | null {
		return this._active;
	}

	createElement(tag: string): DomElement {
		const l = tag.toLowerCase();
		return new DomElement(this, NS_HTML, l, l.toUpperCase());
	}
	createElementNS(ns: string, name: string): DomElement {
		if (ns === NS_HTML) return new DomElement(this, ns, name.toLowerCase(), name.toUpperCase());
		// SVG (and other) namespaces preserve source case for both localName and tagName.
		return new DomElement(this, ns, name, name);
	}
	createTextNode(data: string): DomText {
		return new DomText(this, data, 3);
	}
	createComment(data: string): DomText {
		return new DomText(this, data, 8);
	}
	createDocumentFragment(): DomNode {
		const f = new DomNode(this);
		f.nodeType = 11;
		return f;
	}

	importNode(node: DomNode, deep?: boolean): DomNode {
		return node.cloneNode(deep);
	}
}

// ---------------------------------------------------------------------------
// A minimal HTML parser — enough for the compact, well-formed strings the tests feed it.
// ---------------------------------------------------------------------------

function parse_tag(src: string): { name: string; attrs: Attr[] } {
	const m = src.match(/^\s*([^\s/>]+)/);
	const name = m ? m[1] : '';
	const attrs: Attr[] = [];
	const rest = src.slice(m ? m[0].length : 0);
	const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	let a: RegExpExecArray | null;
	while ((a = re.exec(rest)) !== null) {
		const val = a[2] ?? a[3] ?? a[4] ?? '';
		attrs.push({ name: a[1], value: val });
	}
	return { name, attrs };
}

function parse(doc: DomDocument, html: string): DomNode[] {
	const root = doc.createDocumentFragment();
	const stack: Array<{ node: DomNode; ns: string }> = [{ node: root, ns: NS_HTML }];
	const top = (): { node: DomNode; ns: string } => stack[stack.length - 1];
	let i = 0;

	while (i < html.length) {
		if (html[i] === '<') {
			if (html.startsWith('<!--', i)) {
				const end = html.indexOf('-->', i + 4);
				top().node.appendChild(doc.createComment(html.slice(i + 4, end)));
				i = end + 3;
				continue;
			}
			if (html[i + 1] === '/') {
				const end = html.indexOf('>', i);
				stack.pop();
				i = end + 1;
				continue;
			}
			const end = html.indexOf('>', i);
			let content = html.slice(i + 1, end);
			let self_close = false;
			if (content.endsWith('/')) {
				self_close = true;
				content = content.slice(0, -1);
			}
			const { name, attrs } = parse_tag(content);
			const parent = top();
			const lname = parent.ns === NS_SVG ? name : name.toLowerCase();
			let ns = parent.ns;
			if (lname.toLowerCase() === 'svg') ns = NS_SVG;
			const el = doc.createElementNS(ns, ns === NS_SVG ? name : lname);
			for (const at of attrs) el.setAttribute(at.name, at.value);
			parent.node.appendChild(el);
			i = end + 1;
			if (!self_close && !VOID.has(lname.toLowerCase())) {
				const child_ns = lname.toLowerCase() === 'foreignobject' ? NS_HTML : ns;
				stack.push({ node: el, ns: child_ns });
			}
		} else {
			const next = html.indexOf('<', i);
			const end = next === -1 ? html.length : next;
			top().node.appendChild(doc.createTextNode(html.slice(i, end)));
			i = end;
		}
	}
	return root.childNodes;
}

// ---------------------------------------------------------------------------
// Install globals + export test helpers.
// ---------------------------------------------------------------------------

export const document = new DomDocument();
(globalThis as unknown as { document: DomDocument }).document = document;
(globalThis as unknown as { Node: typeof DomNode }).Node = DomNode;

/** Parse HTML and return its top-level nodes (the `new_nodes` array for `morph_children`). */
export function frag(html: string): DomNode[] {
	return parse(document, html);
}

/** Parse HTML expecting a single root element and return it (the live `parent`). */
export function el(html: string): DomElement {
	const nodes = parse(document, html);
	const first = nodes.find((n) => n.nodeType === 1);
	if (!first) throw new Error(`no element in: ${html}`);
	return first as DomElement;
}

export { DomElement, DomText, DomNode, NS_SVG, NS_HTML, FORMISH };
