/**
 * REVERSIBLE TRANSFORMS — an app's server transform (a web-component server render, say) may reshape
 * the markup ogygia hands it, Svelte-owned markup included, and ogygia puts back what hydration needs.
 *
 * The one rule this rests on, vendor-neutral: **a custom element's server render may move its light
 * DOM children** (a scoped render emulates slots by moving them into its rendered tree). So:
 *
 *   1. MARK, before the transform: every custom element gets an id (`og-h="K"` when ogygia will restore
 *      it — in Svelte-owned markup, above Svelte-owned markup, or anywhere in a hole / lake answer;
 *      `og-u="K"` otherwise), and each of its children a tag (`og-c="K.i"` on an element, a
 *      `<!--og-c K.i t|c-->` comment before a text or comment node). Text a trimmer could change,
 *      deeper inside a restored host's children, gets `<!--og-t K.n-->`.
 *   2. The app's transform runs. On an `og-h` host it renders the plan: its slot positions as real
 *      `<slot>` wrappers, `og-shadow="key …"` (the sheets for the host's shadow root), `og-keep="attr …"`.
 *   3. SETTLE, after it: hosts without a plan (no `og-shadow`) lose every mark and are left as the
 *      transform wrote them; a planned host keeps its marks plus what the restorer needs to put the
 *      children back exactly (`og-r`: the attributes to reset; the original text of a trimmed or
 *      dropped text node). Start tags the HTML parser would restructure (an `<a>` in an `<a>`, a block
 *      in a `<p>`, …) where the render introduced the tag or the element it would close become
 *      `<og-as tag="…">` stand-ins. `data-og-head` assets move into `<head>` (a document), deduped.
 *
 * The browser half (runtime/restore.ts) attaches each planned host's shadow root, moves the rendered
 * tree into it, and puts Svelte's children back — before anything snapshots or hydrates.
 *
 * Pure string work over one tokenizer pass each (indexOf-driven, no regex, no DOM): it runs on every
 * response of an app that configures a transform.
 */

// ─── tokenizer ─────────────────────────────────────────────────────────────────────────────────────

type Tok =
	| { t: 'start'; name: string; start: number; end: number; name_end: number; self: boolean }
	| { t: 'end'; name: string; start: number; end: number }
	| { t: 'text'; start: number; end: number }
	| { t: 'comment'; start: number; end: number }
	| { t: 'raw'; start: number; end: number }
	| { t: 'other'; start: number; end: number };

const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen', 'frame']);

function is_space(c: number): boolean {
	return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}
function is_alpha(c: number): boolean {
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Index of the `>` ending the tag at `open`, respecting quoted values; `html.length` if none. */
function tag_end(html: string, open: number): number {
	let quote = 0;
	for (let i = open + 1; i < html.length; i++) {
		const c = html.charCodeAt(i);
		if (quote) {
			if (c === quote) quote = 0;
		} else if (c === 34 || c === 39) quote = c;
		else if (c === 62) return i;
	}
	return html.length;
}

function read_name(html: string, from: number): number {
	let i = from;
	while (i < html.length) {
		const c = html.charCodeAt(i);
		if (is_space(c) || c === 62 || c === 47) break;
		i++;
	}
	return i;
}

/** The raw-text body end (`<` of the matching `</name`), or `html.length`. */
function raw_end(html: string, from: number, name: string): number {
	let at = from;
	for (;;) {
		const lt = html.indexOf('</', at);
		if (lt === -1) return html.length;
		let ok = true;
		for (let k = 0; k < name.length; k++) {
			const c = html.charCodeAt(lt + 2 + k);
			if ((c >= 65 && c <= 90 ? c + 32 : c) !== name.charCodeAt(k)) {
				ok = false;
				break;
			}
		}
		const after = html.charCodeAt(lt + 2 + name.length);
		if (ok && (Number.isNaN(after) || is_space(after) || after === 62 || after === 47)) return lt;
		at = lt + 2;
	}
}

function* tokens(html: string): Generator<Tok> {
	const n = html.length;
	let i = 0;
	while (i < n) {
		const lt = html.indexOf('<', i);
		if (lt === -1) {
			yield { t: 'text', start: i, end: n };
			return;
		}
		const c1 = html.charCodeAt(lt + 1);
		const is_tag = is_alpha(c1) || (c1 === 47 && is_alpha(html.charCodeAt(lt + 2))) || c1 === 33 || c1 === 63;
		if (!is_tag) {
			// a stray `<` is text: keep scanning for the next real tag, one text token for the run
			let j = lt + 1;
			for (;;) {
				const nx = html.indexOf('<', j);
				if (nx === -1) {
					j = n;
					break;
				}
				const d = html.charCodeAt(nx + 1);
				if (is_alpha(d) || (d === 47 && is_alpha(html.charCodeAt(nx + 2))) || d === 33 || d === 63) {
					j = nx;
					break;
				}
				j = nx + 1;
			}
			yield { t: 'text', start: i, end: j };
			i = j;
			continue;
		}
		if (lt > i) yield { t: 'text', start: i, end: lt };
		if (html.startsWith('<!--', lt)) {
			const close = html.indexOf('-->', lt + 4);
			const end = close === -1 ? n : close + 3;
			yield { t: 'comment', start: lt, end };
			i = end;
			continue;
		}
		if (c1 === 33 || c1 === 63) {
			const gt = tag_end(html, lt);
			yield { t: 'other', start: lt, end: gt + 1 };
			i = gt + 1;
			continue;
		}
		if (c1 === 47) {
			const ne = read_name(html, lt + 2);
			const gt = tag_end(html, lt);
			yield { t: 'end', name: html.slice(lt + 2, ne).toLowerCase(), start: lt, end: gt + 1 };
			i = gt + 1;
			continue;
		}
		const ne = read_name(html, lt + 1);
		const name = html.slice(lt + 1, ne).toLowerCase();
		const gt = tag_end(html, lt);
		const self = html.charCodeAt(gt - 1) === 47;
		yield { t: 'start', name, start: lt, end: gt + 1, name_end: ne, self };
		i = gt + 1;
		if (RAW.has(name) && !self) {
			const re = raw_end(html, i, name);
			if (re > i) yield { t: 'raw', start: i, end: re };
			i = re;
		}
	}
}

// ─── attributes (no regex: this runs on every start tag of every response) ─────────────────────────

interface Attr {
	name: string;
	value: string;
	/** span of the whole attribute (name through value), for removal */
	start: number;
	end: number;
}

function parse_attrs(html: string, from: number, to: number): Attr[] {
	const out: Attr[] = [];
	let i = from;
	while (i < to) {
		let c = html.charCodeAt(i);
		if (is_space(c) || c === 47) {
			i++;
			continue;
		}
		const ns = i;
		while (i < to) {
			c = html.charCodeAt(i);
			if (is_space(c) || c === 61 || c === 62 || c === 47) break;
			i++;
		}
		const name = html.slice(ns, i).toLowerCase();
		let j = i;
		while (j < to && is_space(html.charCodeAt(j))) j++;
		if (html.charCodeAt(j) === 61) {
			j++;
			while (j < to && is_space(html.charCodeAt(j))) j++;
			const q = html.charCodeAt(j);
			let value: string;
			if (q === 34 || q === 39) {
				const close = html.indexOf(q === 34 ? '"' : "'", j + 1);
				const e = close === -1 || close > to ? to : close;
				value = html.slice(j + 1, e);
				j = e + 1;
			} else {
				const vs = j;
				while (j < to && !is_space(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++;
				value = html.slice(vs, j);
			}
			if (name) out.push({ name, value: decode(value), start: ns, end: j });
			i = j;
		} else {
			if (name) out.push({ name, value: '', start: ns, end: i });
			if (i === ns) i++;
		}
	}
	return out;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Decode character references (the common named ones and every numeric one): enough to compare two
 *  serializations of the same text or attribute value. */
export function decode(s: string): string {
	if (s.indexOf('&') === -1) return s;
	let out = '';
	let i = 0;
	for (;;) {
		const amp = s.indexOf('&', i);
		if (amp === -1) return out + s.slice(i);
		out += s.slice(i, amp);
		const semi = s.indexOf(';', amp);
		if (semi === -1 || semi - amp > 10) {
			out += '&';
			i = amp + 1;
			continue;
		}
		const ref = s.slice(amp + 1, semi);
		let ch: string | undefined;
		if (ref.charCodeAt(0) === 35) {
			const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
			if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) ch = String.fromCodePoint(code);
		} else ch = NAMED[ref];
		if (ch === undefined) {
			out += '&';
			i = amp + 1;
		} else {
			out += ch;
			i = semi + 1;
		}
	}
}

function esc_attr(s: string): string {
	return s.split('&').join('&amp;').split('"').join('&quot;');
}
/** JSON safe inside an HTML comment: no `--`, no `>`. */
function comment_json(v: unknown): string {
	return JSON.stringify(v).split('-').join('\\u002d').split('>').join('\\u003e');
}
function script_json(v: unknown): string {
	return JSON.stringify(v).split('<').join('\\u003c');
}

// ─── the open-element stack, with the parser's implied closes ──────────────────────────────────────

const P_CLOSERS = new Set([
	'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section', 'summary', 'ul',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'table', 'hr', 'xmp', 'li', 'dd', 'dt', 'plaintext'
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', 'foreignobject', 'desc']);

interface Frame {
	name: string;
	/** a custom element's id (K), or -1 */
	host: number;
	/** index of the next child of this element (for a host: the tag counter) */
	next: number;
	/** inside Svelte-owned markup */
	owned: boolean;
	/** mark: inside the children of a planned host (the nearest one), -1 if none */
	under: number;
	/** settle: the render introduced this element (inside a host, not inside a tagged child) */
	introduced: boolean;
	/** settle: a stand-in's real tag */
	as?: string;
	/** inside svg / math */
	foreign: boolean;
	/** the region kind this element opened (an `<ogygia-region>`) */
	region?: 'island' | 'lake' | 'hole';
}

function in_scope(stack: Frame[], name: string, extra?: Set<string>): number {
	for (let k = stack.length - 1; k >= 0; k--) {
		const f = stack[k];
		if ((f.as ?? f.name) === name) return k;
		if (SCOPE.has(f.name) || extra?.has(f.name)) return -1;
	}
	return -1;
}
const BUTTON_SCOPE = new Set(['button']);
const LIST_SCOPE = new Set(['ol', 'ul']);

/** What the parser does to the stack BEFORE inserting start tag `name`: the index of the element it
 *  would close (and everything above it), or -1. `drop`: the parser ignores the tag (a form in a form). */
function implied_close(stack: Frame[], name: string): { close: number; drop?: boolean } {
	if (name === 'a') return { close: in_scope(stack, 'a') };
	if (name === 'nobr') return { close: in_scope(stack, 'nobr') };
	if (name === 'button') return { close: in_scope(stack, 'button') };
	if (name === 'form') {
		const f = in_scope(stack, 'form');
		return f === -1 ? { close: -1 } : { close: -1, drop: true };
	}
	if (name === 'li') {
		const li = in_scope(stack, 'li', LIST_SCOPE);
		if (li !== -1) return { close: li };
	}
	if (name === 'dd' || name === 'dt') {
		const a = in_scope(stack, 'dd');
		const b = in_scope(stack, 'dt');
		const k = Math.max(a, b);
		if (k !== -1) return { close: k };
	}
	if (P_CLOSERS.has(name)) {
		const p = in_scope(stack, 'p', BUTTON_SCOPE);
		if (p !== -1) return { close: p };
		if (HEADINGS.has(name)) {
			const top = stack[stack.length - 1];
			if (top && HEADINGS.has(top.as ?? top.name)) return { close: stack.length - 1 };
		}
	}
	if (name === 'option' || name === 'optgroup') {
		const top = stack[stack.length - 1];
		if (top && (top.as ?? top.name) === 'option') return { close: stack.length - 1 };
	}
	if (name === 'td' || name === 'th') {
		const k = Math.max(in_scope(stack, 'td'), in_scope(stack, 'th'));
		if (k !== -1) return { close: k };
	}
	if (name === 'tr') {
		const k = in_scope(stack, 'tr');
		if (k !== -1) return { close: k };
	}
	return { close: -1 };
}

function pop_to(stack: Frame[], name: string): void {
	for (let k = stack.length - 1; k >= 0; k--) {
		if ((stack[k].as ?? stack[k].name) === name) {
			stack.length = k;
			return;
		}
	}
}

function is_custom(name: string, foreign: boolean): boolean {
	if (foreign || name.indexOf('-') === -1 || !is_alpha(name.charCodeAt(0))) return false;
	return !name.startsWith('ogygia-') && !name.startsWith('og-');
}

function region_kind(attrs: Attr[]): 'island' | 'lake' | 'hole' {
	if (attrs.some((a) => a.name === 'endpoint')) return 'hole';
	if (attrs.some((a) => a.name === 'wake' && a.value === 'none')) return 'lake';
	return 'island';
}

/** Text the serializer could change: whitespace-only, or with leading / trailing whitespace. */
function trimmable(s: string): boolean {
	if (!s.length) return false;
	const a = s.charCodeAt(0);
	const b = s.charCodeAt(s.length - 1);
	return is_space(a) || is_space(b) || a === 160 || b === 160 || s.indexOf('&nbsp;') !== -1 || s.indexOf('&#160;') !== -1;
}

// ─── mark ──────────────────────────────────────────────────────────────────────────────────────────

/** `document`: a page render. `region`: a region answer (a hole, a lake remount) — every custom
 *  element in it gets a plan, since the page morphs it over live hosts. */
export type TransformKind = 'document' | 'region';

interface HostRecord {
	planned: boolean;
	/** inside Svelte-owned markup (its children are hydrated): the dev check compares these */
	owned: boolean;
	attrs: Record<string, string>;
	/** child i: an element's attributes, a text node's original text */
	children: Map<number, { attrs?: Record<string, string>; text?: string }>;
	/** og-t n: the original text */
	texts: Map<number, string>;
	text_next: number;
	/** the original inner HTML span, for the dev check */
	inner_start: number;
	inner_end: number;
}

export interface MarkRecord {
	kind: TransformKind;
	source: string;
	hosts: Map<number, HostRecord>;
}

const attr_map = (attrs: Attr[]): Record<string, string> => {
	const m: Record<string, string> = {};
	for (const a of attrs) m[a.name] = a.value;
	return m;
};

/**
 * Which custom elements (in document order) get a plan: every one in a hole / lake answer; in a
 * document, every one in Svelte-owned markup, and every one with Svelte-owned markup below it (a
 * server-owned host around an island: adopting it would reach into the island). A first pass, so
 * the marking pass knows a host's plan before it reaches the host's children.
 */
function plan_hosts(html: string, kind: TransformKind, csr: boolean): boolean[] {
	const planned: boolean[] = [];
	const stack: { name: string; host: number; owned: boolean; foreign: boolean }[] = [];
	let in_body = kind !== 'document';
	for (const tok of tokens(html)) {
		if (tok.t === 'start') {
			const name = tok.name;
			if (name === 'body') in_body = true;
			const { close, drop } = implied_close(stack as unknown as Frame[], name);
			if (close !== -1) stack.length = close;
			if (drop) continue;
			const parent = stack[stack.length - 1];
			const foreign = name === 'svg' || name === 'math' || !!parent?.foreign;
			let owned = (name === 'body' && kind === 'document' && csr) || (parent ? parent.owned : false);
			if (name === 'ogygia-region') owned = region_kind(parse_attrs(html, tok.name_end, tok.end - 1)) === 'island';
			let host = -1;
			if (in_body && is_custom(name, foreign)) {
				host = planned.length;
				planned.push(kind !== 'document' || owned);
			}
			// Svelte-owned markup starts here: every host above it gets the plan
			if (owned && !(parent ? parent.owned : false)) for (const f of stack) if (f.host !== -1) planned[f.host] = true;
			if (!(VOID.has(name) || (tok.self && foreign))) stack.push({ name, host, owned, foreign });
		} else if (tok.t === 'end') {
			pop_to(stack as unknown as Frame[], tok.name);
		}
	}
	return planned;
}

/**
 * Tag `html` for the transform. `csr`: a Kit-hydrated document (its whole body is Svelte's, except
 * lakes and holes). Returns the tagged HTML, or `null` when there is no custom element to tag (the
 * transform then gets the HTML as is, and settle has nothing to do).
 */
export function mark(html: string, kind: TransformKind, csr: boolean): { html: string; record: MarkRecord } | null {
	if (html.indexOf('-') === -1) return null;
	const planned = plan_hosts(html, kind, csr);
	if (!planned.length) return null;
	const out: string[] = [];
	let pos = 0;
	const hosts = new Map<number, HostRecord>();
	let next_k = 0;
	const stack: Frame[] = [];
	let in_body = kind !== 'document';
	let last_was_pre_start = false;

	const top = () => stack[stack.length - 1];
	const under_now = () => (top() ? top().under : -1);

	for (const tok of tokens(html)) {
		if (tok.t === 'start') {
			const name = tok.name;
			if (name === 'body') in_body = true;
			const { close, drop } = implied_close(stack, name);
			if (close !== -1) stack.length = close;
			if (drop) continue;
			const parent = top();
			const foreign = name === 'svg' || name === 'math' || !!parent?.foreign;
			const custom = in_body && is_custom(name, foreign);
			const child_of_host = !!parent && parent.host !== -1 && in_body;
			const attrs = name === 'ogygia-region' || name === 'template' || custom || child_of_host ? parse_attrs(html, tok.name_end, tok.end - 1) : [];
			// (a Kit-hydrated document: Svelte owns its whole body, lakes and holes aside)
			let owned = (name === 'body' && kind === 'document' && csr) || (parent ? parent.owned : false);
			if (name === 'ogygia-region') owned = region_kind(attrs) === 'island';
			// the child tag: this element is child i of the custom element above it (a declarative
			// shadow template is not a child once parsed: it becomes the host's shadow root)
			let insert = '';
			const shadow_tpl = name === 'template' && attrs.some((a) => a.name === 'shadowrootmode');
			if (child_of_host && !shadow_tpl) {
				const i = parent.next++;
				insert += ` og-c="${parent.host}.${i}"`;
				hosts.get(parent.host)!.children.set(i, { attrs: attr_map(attrs) });
			}
			let host = -1;
			if (custom) {
				host = next_k++;
				const is_planned = planned[host] ?? false;
				hosts.set(host, {
					planned: is_planned,
					owned,
					attrs: attr_map(attrs),
					children: new Map(),
					texts: new Map(),
					text_next: 0,
					inner_start: tok.end,
					inner_end: tok.end
				});
				insert += is_planned ? ` og-h="${host}"` : ` og-u="${host}"`;
			}
			if (insert) {
				out.push(html.slice(pos, tok.name_end), insert);
				pos = tok.name_end;
			}
			if (!(VOID.has(name) || (tok.self && foreign))) {
				stack.push({
					name,
					host,
					next: 0,
					owned,
					// the text marks: inside a planned host's children, the nearest planned host
					under: host !== -1 && planned[host] ? host : under_now(),
					introduced: false,
					foreign
				});
			}
			last_was_pre_start = name === 'pre' || name === 'listing';
			continue;
		}
		if (tok.t === 'end') {
			const name = tok.name;
			for (let k = stack.length - 1; k >= 0; k--) {
				if (stack[k].name === name) {
					for (let j = stack.length - 1; j >= k; j--) {
						const f = stack[j];
						if (f.host !== -1) hosts.get(f.host)!.inner_end = tok.start;
					}
					stack.length = k;
					break;
				}
			}
			last_was_pre_start = false;
			continue;
		}
		if (tok.t === 'text' || tok.t === 'comment') {
			const parent = top();
			if (parent && parent.host !== -1 && in_body && !hosts.get(parent.host)!.planned) {
				// a host ogygia will not restore: only its element children carry a tag (the stand-in
				// pass reads those); a comment before a text or comment node would sit between a
				// position-based adopter's own marker and its node
				parent.next++;
			} else if (parent && parent.host !== -1 && in_body) {
				const i = parent.next++;
				const rec = hosts.get(parent.host)!;
				if (tok.t === 'text') {
					const raw = html.slice(tok.start, tok.end);
					rec.children.set(i, { text: raw });
					out.push(html.slice(pos, tok.start), `<!--og-c ${parent.host}.${i} t-->`);
				} else {
					rec.children.set(i, {});
					out.push(html.slice(pos, tok.start), `<!--og-c ${parent.host}.${i} c-->`);
				}
				pos = tok.start;
			} else if (tok.t === 'text' && parent && under_now() !== -1 && !last_was_pre_start) {
				const raw = html.slice(tok.start, tok.end);
				if (trimmable(raw)) {
					const k = under_now();
					const rec = hosts.get(k)!;
					const n = rec.text_next++;
					rec.texts.set(n, raw);
					out.push(html.slice(pos, tok.start), `<!--og-t ${k}.${n}-->`);
					pos = tok.start;
				}
			}
			last_was_pre_start = false;
			continue;
		}
		last_was_pre_start = false;
	}
	if (!hosts.size) return null;
	out.push(html.slice(pos));
	return { html: out.join(''), record: { kind, source: html, hosts } };
}

// ─── settle ────────────────────────────────────────────────────────────────────────────────────────

/** How the stand-ins keep their element's box before the restore swaps them back (zero specificity:
 *  the component's own class rules still win). */
export const STAND_IN_CSS =
	':where(og-as){display:inline}' +
	':where(og-as[tag=address],og-as[tag=article],og-as[tag=aside],og-as[tag=blockquote],og-as[tag=center],og-as[tag=details],og-as[tag=dialog],og-as[tag=dir],og-as[tag=div],og-as[tag=dl],og-as[tag=dd],og-as[tag=dt],og-as[tag=fieldset],og-as[tag=figcaption],og-as[tag=figure],og-as[tag=footer],og-as[tag=form],og-as[tag=header],og-as[tag=hgroup],og-as[tag=main],og-as[tag=menu],og-as[tag=nav],og-as[tag=ol],og-as[tag=p],og-as[tag=search],og-as[tag=section],og-as[tag=summary],og-as[tag=ul],og-as[tag=h1],og-as[tag=h2],og-as[tag=h3],og-as[tag=h4],og-as[tag=h5],og-as[tag=h6],og-as[tag=pre],og-as[tag=listing],og-as[tag=hr],og-as[tag=xmp]){display:block}' +
	':where(og-as[tag=li]){display:list-item}:where(og-as[tag=table]){display:table}:where(og-as[tag=button]){display:inline-block}';

export interface Settled {
	html: string;
	/** planned hosts (with a shadow plan) — the page needs the restorer */
	planned: number;
	/** stand-ins written */
	stand_ins: number;
	/** `data-og-head` assets lifted out of a document's body, for its head (deduped by key) */
	head: string[];
	/** dev: each planned Svelte-owned host's original children, for the browser's check */
	check?: Record<string, string>;
}

/** The attributes a restore resets: `name → Svelte's value`, or `null` to remove. */
function attr_diff(now: Attr[], was: Record<string, string>, keep: Set<string>): Record<string, string | null> | null {
	let diff: Record<string, string | null> | null = null;
	const seen = new Set<string>();
	for (const a of now) {
		if (a.name.startsWith('og-')) continue;
		seen.add(a.name);
		if (a.name in was) {
			if (was[a.name] !== a.value) (diff ??= {})[a.name] = was[a.name];
		} else if (!keep.has(a.name)) (diff ??= {})[a.name] = null;
	}
	for (const name in was) if (!seen.has(name) && !name.startsWith('og-')) (diff ??= {})[name] = was[name];
	return diff;
}

/** Rewrite a start tag: drop the attributes named in `drop`, append `add`, rename to `rename`. */
function rewrite_start(html: string, tok: { start: number; end: number; name_end: number }, attrs: Attr[], drop: Set<string>, add: string, rename?: string): string {
	let s = '<' + (rename ?? html.slice(tok.start + 1, tok.name_end));
	let at = tok.name_end;
	for (const a of attrs) {
		if (!drop.has(a.name)) continue;
		// (with the whitespace before it: ogygia inserted its marks as ` og-…`)
		let from = a.start;
		while (from > at && is_space(html.charCodeAt(from - 1))) from--;
		s += html.slice(at, from);
		at = a.end;
	}
	const close = html.charCodeAt(tok.end - 2) === 47 ? tok.end - 2 : tok.end - 1;
	return s + html.slice(at, close) + add + html.slice(close, tok.end);
}

export function settle(html: string, record: MarkRecord, opts: { dev?: boolean } = {}): Settled {
	// pass 1: the planned hosts the transform gave a plan
	const plan = new Set<number>();
	for (const tok of tokens(html)) {
		if (tok.t !== 'start' || html.indexOf('og-shadow', tok.start) === -1 || html.indexOf('og-shadow', tok.start) > tok.end) continue;
		const attrs = parse_attrs(html, tok.name_end, tok.end - 1);
		const h = attrs.find((a) => a.name === 'og-h');
		if (h && attrs.some((a) => a.name === 'og-shadow')) plan.add(Number(h.value));
	}
	const out: string[] = [];
	let pos = 0;
	const stack: Frame[] = [];
	const head: string[] = [];
	const head_keys = new Set<string>();
	let head_cut: { start: number; name: string; depth: number; key: string } | null = null;
	let stand_ins = 0;
	let pending_text: { k: number; i: number; comment_at: number; og: 'c' | 't' } | null = null;
	const doc = record.kind === 'document';

	/** Close a pending text mark: `text` is the text that follows it in the output (or null: none). */
	const finish_text = (text: string | null) => {
		const p = pending_text!;
		pending_text = null;
		const rec = record.hosts.get(p.k);
		const was = p.og === 'c' ? rec?.children.get(p.i)?.text : rec?.texts.get(p.i);
		if (was === undefined) {
			out[p.comment_at] = '';
			return;
		}
		if (!plan.has(p.k)) {
			// a host with no plan: its mark goes. But a render around it may still have trimmed or dropped
			// the text (a planned host's serializer writes everything below it): then it becomes a text
			// mark of the nearest planned host above, which puts it back when it is restored
			out[p.comment_at] = '';
			if (text === null || decode(text) !== decode(was)) {
				for (let s = stack.length - 1; s >= 0; s--) {
					const a = stack[s].host;
					if (a === -1 || !plan.has(a)) continue;
					const ra = record.hosts.get(a);
					if (ra) out[p.comment_at] = `<!--og-t ${a}.${ra.text_next++} ${comment_json(decode(was))}-->`;
					break;
				}
			}
			return;
		}
		if (p.og === 't') {
			out[p.comment_at] = text !== null && decode(text) === decode(was) ? '' : `<!--og-t ${p.k}.${p.i} ${comment_json(decode(was))}-->`;
			return;
		}
		out[p.comment_at] = text !== null && decode(text) === decode(was) ? `<!--og-c ${p.k}.${p.i} t-->` : `<!--og-c ${p.k}.${p.i} t ${comment_json(decode(was))}-->`;
	};

	for (const tok of tokens(html)) {
		// inside a head asset being lifted out of a document's body: nothing to rewrite until its end
		if (head_cut) {
			if (tok.t === 'end' && tok.name === head_cut.name && --head_cut.depth === 0) {
				const asset = html.slice(head_cut.start, tok.end);
				pos = tok.end;
				if (!head_keys.has(head_cut.key)) {
					head_keys.add(head_cut.key);
					head.push(asset);
				}
				head_cut = null;
			} else if (tok.t === 'start' && tok.name === head_cut.name) head_cut.depth++;
			continue;
		}
		if (pending_text && tok.t !== 'text') finish_text(null);
		if (tok.t === 'text') {
			if (pending_text) {
				out.push(html.slice(pos, tok.start));
				pos = tok.start;
				finish_text(html.slice(tok.start, tok.end));
			}
			continue;
		}
		if (tok.t === 'comment') {
			const body = html.slice(tok.start + 4, tok.end - 3);
			const is_c = body.startsWith('og-c ');
			const is_t = body.startsWith('og-t ');
			if (!is_c && !is_t) continue;
			const sp = body.indexOf(' ', 5);
			const id = body.slice(5, sp === -1 ? body.length : sp);
			const dot = id.indexOf('.');
			const k = Number(id.slice(0, dot));
			const i = Number(id.slice(dot + 1));
			out.push(html.slice(pos, tok.start));
			pos = tok.end;
			if (is_c && body.endsWith(' c')) {
				out.push(plan.has(k) ? html.slice(tok.start, tok.end) : '');
				continue;
			}
			out.push(''); // filled by finish_text
			pending_text = { k, i, comment_at: out.length - 1, og: is_c ? 'c' : 't' };
			continue;
		}
		if (tok.t === 'start') {
			const name = tok.name;
			const { close, drop } = implied_close(stack, name);
			const parent = stack[stack.length - 1];
			const has_og = (() => {
				const at = html.indexOf(' og-', tok.start);
				return at !== -1 && at < tok.end;
			})();
			const head_attr = (() => {
				const at = html.indexOf('data-og-head', tok.start);
				return at !== -1 && at < tok.end;
			})();
			const attrs = has_og || head_attr || close !== -1 ? parse_attrs(html, tok.name_end, tok.end - 1) : [];
			// a head asset in a document's body: lifted into the head (deduped by key)
			if (doc && head_attr && !has_og) {
				const key = attrs.find((a) => a.name === 'data-og-head')?.value;
				if (key !== undefined && (name === 'style' || name === 'link' || name === 'template')) {
					out.push(html.slice(pos, tok.start));
					pos = tok.start;
					if (name === 'link' || tok.self) {
						pos = tok.end;
						if (!head_keys.has(key)) {
							head_keys.add(key);
							head.push(html.slice(tok.start, tok.end));
						}
					} else head_cut = { start: tok.start, name, depth: 1, key };
					continue;
				}
			}
			const og_c = has_og ? attrs.find((a) => a.name === 'og-c') : undefined;
			const og_h = has_og ? attrs.find((a) => a.name === 'og-h' || a.name === 'og-u') : undefined;
			const foreign = name === 'svg' || name === 'math' || !!parent?.foreign;
			const is_host = !!og_h;
			// the render introduced this element: inside a host, not a tagged child, or inherited
			const introduced = og_c ? false : parent ? (parent.host !== -1 ? true : parent.introduced) : false;
			// a start tag the parser would restructure, where the render made either side of it
			let stand_in = false;
			if ((close !== -1 || drop) && !foreign) {
				const trigger = close !== -1 ? stack[close] : undefined;
				if (introduced || trigger?.introduced || (drop && introduced)) stand_in = true;
			}
			if (!stand_in) {
				if (close !== -1) stack.length = close;
				if (drop) continue;
			}
			// the rewrite
			const remove = new Set<string>();
			let add = '';
			// ONE attribute reset per element: a planned host's own (it honours og-keep) wins over its
			// reset as a tagged child of the host above (the same attributes, without og-keep)
			let reset: Record<string, string | null> | null = null;
			let planned_host = false;
			if (og_h) {
				const k = Number(og_h.value);
				if (og_h.name === 'og-u' || !plan.has(k)) {
					remove.add(og_h.name);
					remove.add('og-shadow');
					remove.add('og-keep');
				} else {
					planned_host = true;
					const keep = new Set((attrs.find((a) => a.name === 'og-keep')?.value ?? '').split(' ').filter(Boolean));
					reset = attr_diff(attrs, record.hosts.get(k)?.attrs ?? {}, keep);
				}
			}
			if (og_c) {
				const dot = og_c.value.indexOf('.');
				const k = Number(og_c.value.slice(0, dot));
				if (!plan.has(k)) remove.add('og-c');
				// (a tagged child that is itself a host ogygia won't restore is server markup: its own runtime
				// adopts it by the attributes the render gave it — they are not Svelte's to reset)
				else if (!planned_host && og_h?.name !== 'og-u') {
					const was = record.hosts.get(k)?.children.get(Number(og_c.value.slice(dot + 1)))?.attrs ?? {};
					reset = attr_diff(attrs, was, new Set());
				}
			}
			if (reset) add += ` og-r="${esc_attr(JSON.stringify(reset))}"`;
			if (stand_in) {
				add += ` tag="${name}"`;
				stand_ins++;
			}
			if (remove.size || add || stand_in) {
				out.push(html.slice(pos, tok.start), rewrite_start(html, tok, attrs, remove, add, stand_in ? 'og-as' : undefined));
				pos = tok.end;
			}
			const is_void = VOID.has(name) || (tok.self && foreign);
			if (!is_void)
				stack.push({ name: stand_in ? 'og-as' : name, as: stand_in ? name : undefined, host: is_host ? Number(og_h!.value) : -1, next: 0, owned: false, under: -1, introduced, foreign });
			continue;
		}
		if (tok.t === 'end') {
			const name = tok.name;
			// the end tag of a stand-in becomes `</og-as>`
			for (let k = stack.length - 1; k >= 0; k--) {
				const f = stack[k];
				if ((f.as ?? f.name) === name) {
					if (f.as) {
						out.push(html.slice(pos, tok.start), '</og-as>');
						pos = tok.end;
					}
					stack.length = k;
					break;
				}
			}
			continue;
		}
	}
	if (pending_text) finish_text(null);
	out.push(html.slice(pos));
	// dev: every planned host's original children (restored exactly, so the browser can compare)
	let check: Record<string, string> | undefined;
	if (opts.dev) {
		for (const k of plan) {
			const rec = record.hosts.get(k);
			if (rec && rec.planned) (check ??= {})[k] = record.source.slice(rec.inner_start, rec.inner_end);
		}
	}
	return { html: out.join(''), planned: plan.size, stand_ins, head, ...(check ? { check } : {}) };
}

/** The dev check's payload: each planned Svelte-owned host's original children, by its id. */
export function check_script(check: Record<string, string>): string {
	return `<script type="application/ogygia-restore-check">${script_json(check)}</script>`;
}

/** The host id right after `at` (digits), and where they end. */
function read_id(s: string, at: number): { id: number; end: number } | null {
	let n = 0;
	let j = at;
	while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) n = n * 10 + (s.charCodeAt(j++) - 48);
	return j === at ? null : { id: n, end: j };
}

const MARK_PREFIXES = ['og-h="', 'og-u="', 'og-c="', '<!--og-c ', '<!--og-t '];

/** Rewrite every host id in ogygia's marks through `map` (ids it lacks stay). */
function remap(html: string, map: (id: number) => number | undefined): string {
	let out = '';
	let pos = 0;
	for (;;) {
		let best = -1;
		let len = 0;
		for (const p of MARK_PREFIXES) {
			const at = html.indexOf(p, pos);
			if (at !== -1 && (best === -1 || at < best)) {
				best = at;
				len = p.length;
			}
		}
		if (best === -1) return out + html.slice(pos);
		const r = read_id(html, best + len);
		if (!r) {
			out += html.slice(pos, best + len);
			pos = best + len;
			continue;
		}
		const to = map(r.id);
		out += html.slice(pos, best + len) + (to === undefined ? r.id : to);
		pos = r.end;
	}
}

/**
 * STABLE MARKS FOR A CACHING TRANSFORM. ogygia numbers hosts across the whole document, so the same
 * block carries other ids on another page, and a render cache keyed on its markup never hits.
 * `localizeMarks(block)` renumbers the block's marks from 0 (in order of appearance): cache on the
 * result, then `back(rendered)` puts the document's ids back on whatever the render returned.
 *
 * ```ts
 * const local = localizeMarks(block);
 * const rendered = cache.get(local.html) ?? cache.set(local.html, await render(local.html));
 * return local.back(rendered);
 * ```
 */
export function localizeMarks(html: string): { html: string; back: (rendered: string) => string } {
	const to_local = new Map<number, number>();
	const local = remap(html, (id) => {
		let l = to_local.get(id);
		if (l === undefined) to_local.set(id, (l = to_local.size));
		return l;
	});
	const to_doc = new Map([...to_local].map(([d, l]) => [l, d]));
	return { html: local, back: (rendered) => remap(rendered, (id) => to_doc.get(id)) };
}

/**
 * The whole server round trip for one piece of markup: mark → the app's transform → settle. Kit-free
 * (exported from `ogygia/markup` for tests that harvest markup and run a transform over it).
 */
export async function transformMarkup(
	html: string,
	transform: (html: string) => string | Promise<string>,
	opts: { kind?: TransformKind; csr?: boolean; dev?: boolean } = {}
): Promise<Settled> {
	const kind = opts.kind ?? 'region';
	const marked = mark(html, kind, !!opts.csr);
	if (!marked) {
		const out = await transform(html);
		return { html: out, planned: 0, stand_ins: 0, head: [] };
	}
	return settle(await transform(marked.html), marked.record, { dev: opts.dev });
}
