/**
 * THE RESTORER — the browser half of reversible transforms (server/reversible.ts). An app's server
 * transform rendered each planned custom element (`og-h`) in scoped form: its rendered tree in the
 * host's light DOM, Svelte's children moved into `<slot>` wrappers inside it. This puts it back into
 * the form hydration and the component's runtime both expect:
 *
 *   1. stand-ins (`<og-as tag="a">`: tags the HTML parser would have restructured) become their real
 *      element, in place — a DOM operation, which no content-model rule applies to;
 *   2. for each planned host, innermost first: an open shadow root with the host's keyed sheets, the
 *      rendered tree moved into it (its `<slot>` wrappers become real slots), Svelte's children back
 *      in the light DOM in their original order and exactly as Svelte rendered them (attributes reset,
 *      trimmed or dropped text put back), the host's attributes back to Svelte's (except `og-keep`).
 *
 * The page stays painted the same throughout: the scoped form and the shadow form render alike, and
 * each host is restored in one task. It must run before anything reads the markup — before an island
 * snapshots or hydrates, before Kit starts, before a web-component runtime upgrades a host. So the
 * handle inlines it at the end of the document's body (`restore.toString()`: this function is
 * self-contained, no imports, no outer names), and the runtime calls it on a hole / lake answer before
 * insertion and on an incoming page before a router swap.
 *
 * A host that already has a shadow root when it is reached was upgraded first — the restore came
 * too late. It is left as served and reported (`ogygia:restore-late` on the host), never restored into
 * a root the component's own constructor made (that tree would render twice).
 */
export function restore(root: Document | DocumentFragment | Element): number {
	const doc: Document = (root as Node).ownerDocument ?? (root as Document);
	const head = document.head;
	const W = window as unknown as {
		__og_sheets?: Map<string, CSSStyleSheet | string>;
		__og_adopt?: { shadow: ShadowRoot; sheets: CSSStyleSheet[] }[];
	};
	const sheets = (W.__og_sheets ??= new Map());
	// A constructed sheet can only be adopted by a root in the document that made it: a root made in
	// an answer's inert fragment (or an incoming page's parsed document) adopts once its host is in
	// the page — `restore_adopt()`, called right after the insertion, in the same task.
	const live = doc === document;
	let restored = 0;

	// 0. head assets an answer carries (`data-og-head`): into the page's head once per key
	if (root !== document && (root as ParentNode).querySelectorAll) {
		for (const el of Array.from((root as ParentNode).querySelectorAll('[data-og-head]'))) {
			const key = el.getAttribute('data-og-head')!;
			if (head.querySelector(`[data-og-head="${CSS.escape(key)}"]`)) el.remove();
			else head.appendChild(el);
		}
	}

	const sheet_for = (key: string): CSSStyleSheet | string | null => {
		const have = sheets.get(key);
		if (have) return have;
		const sel = `template[data-og-head="${CSS.escape(key)}"]`;
		// (an incoming page carries its sheets in its own head until the swap)
		const tpl = ((doc !== document && doc.head?.querySelector(sel)) || head.querySelector(sel)) as HTMLTemplateElement | null;
		if (!tpl) return null;
		const css = tpl.content.textContent ?? '';
		let made: CSSStyleSheet | string = css;
		try {
			const s = new CSSStyleSheet();
			s.replaceSync(css);
			made = s;
		} catch {
			// no constructable stylesheets: a <style> per root
		}
		sheets.set(key, made);
		return made;
	};

	const reset = (el: Element) => {
		const r = el.getAttribute('og-r');
		if (r) {
			try {
				const diff = JSON.parse(r) as Record<string, string | null>;
				for (const name in diff) {
					const v = diff[name];
					if (v === null) el.removeAttribute(name);
					else el.setAttribute(name, v);
				}
			} catch {
				// a mangled diff: leave the attributes
			}
		}
		el.removeAttribute('og-r');
	};

	/** A mark's original text (`<!--og-c K.i t "…"-->`, `<!--og-t K.n "…"-->`), or undefined. */
	const original = (data: string): string | undefined => {
		const q = data.indexOf(' "');
		if (q === -1) return undefined;
		try {
			return JSON.parse(data.slice(q + 1)) as string;
		} catch {
			return undefined;
		}
	};

	/** Put back the text after a text mark (trimmed, or dropped: then a new node), then drop the mark. */
	const fix_text = (mark: Comment) => {
		const was = original(mark.data);
		if (was !== undefined) {
			const next = mark.nextSibling;
			if (next && next.nodeType === 3) (next as Text).data = was;
			else mark.parentNode!.insertBefore(doc.createTextNode(was), next);
		}
		const node = mark.nextSibling;
		mark.remove();
		return node;
	};

	const comments = (under: Node, prefix: string): Comment[] => {
		const out: Comment[] = [];
		const walk = doc.createTreeWalker(under, 128 /* SHOW_COMMENT */);
		for (let n = walk.nextNode(); n; n = walk.nextNode()) if ((n as Comment).data.startsWith(prefix)) out.push(n as Comment);
		return out;
	};

	const swap_stand_ins = (under: ParentNode) => {
		const list = Array.from(under.querySelectorAll('og-as'));
		for (let x = list.length - 1; x >= 0; x--) {
			const as = list[x];
			const real = doc.createElement(as.getAttribute('tag') || 'span');
			for (const a of Array.from(as.attributes)) if (a.name !== 'tag') real.setAttribute(a.name, a.value);
			while (as.firstChild) real.appendChild(as.firstChild);
			as.replaceWith(real);
		}
	};

	// dev: each planned host's original children (the server sends them only in dev), to compare each
	// restored host against — the transform is judged on what hydration will actually see
	let check: Record<string, string> | null = null;
	const check_el = (root as ParentNode).querySelector('script[type="application/ogygia-restore-check"]');
	if (check_el) {
		try {
			check = JSON.parse(check_el.textContent || '{}');
		} catch {
			check = null;
		}
		check_el.remove();
	}
	/** The first difference between Svelte's children and the restored ones (node types, tags, text,
	 *  comments, attributes — a web-component host may carry more than Svelte's: `og-keep`), or null. */
	const differ = (want: Node, got: Node, path: string): string | null => {
		const a = want.childNodes;
		const b = got.childNodes;
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const x = a[i];
			const y = b[i];
			const here = `${path} > [${i}]`;
			if (!x || !y) return `${here}: Svelte has ${x ? describe(x) : 'nothing'}, the restored markup has ${y ? describe(y) : 'nothing'}`;
			if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return `${here}: Svelte has ${describe(x)}, the restored markup has ${describe(y)}`;
			if (x.nodeType === 3 || x.nodeType === 8) {
				if ((x as CharacterData).data !== (y as CharacterData).data) return `${here}: Svelte has ${describe(x)}, the restored markup has ${describe(y)}`;
				continue;
			}
			if (x.nodeType !== 1) continue;
			const ex = x as Element;
			const ey = y as Element;
			for (const attr of Array.from(ex.attributes))
				if (ey.getAttribute(attr.name) !== attr.value) return `${here} <${ex.localName}>: Svelte has ${attr.name}="${attr.value}", the restored markup has ${ey.hasAttribute(attr.name) ? `"${ey.getAttribute(attr.name)}"` : 'none'}`;
			if (ex.localName.indexOf('-') === -1)
				for (const attr of Array.from(ey.attributes)) if (!ex.hasAttribute(attr.name)) return `${here} <${ex.localName}>: the restored markup adds ${attr.name}="${attr.value}"`;
			const deeper = differ(x, y, `${here} <${ex.localName}>`);
			if (deeper) return deeper;
		}
		return null;
	};
	const describe = (n: Node): string =>
		n.nodeType === 3 ? `the text ${JSON.stringify((n as Text).data)}` : n.nodeType === 8 ? `the comment <!--${(n as Comment).data}-->` : `<${(n as Element).localName}>`;
	const verify = (host: Element, k: string) => {
		const want = check?.[k];
		if (want === undefined) return;
		const tpl = doc.createElement('template');
		tpl.innerHTML = want;
		const diff = differ(tpl.content, host, `<${host.localName}>`);
		if (!diff) return;
		console.error(`[ogygia] the transform broke hydration markup: ${diff}`);
		host.dispatchEvent(new CustomEvent('ogygia:restore-mismatch', { bubbles: true, detail: { host: host.localName, diff } }));
	};

	// 1. stand-ins first: a Svelte child can be one (a block in the tree's `<p>`), and the children are
	//    found by their tags below
	swap_stand_ins(root as ParentNode);

	// 2. the planned hosts, innermost first
	const hosts = Array.from((root as ParentNode).querySelectorAll('[og-h]'));
	for (let x = hosts.length - 1; x >= 0; x--) {
		const host = hosts[x] as HTMLElement;
		const k = host.getAttribute('og-h')!;
		const keys = (host.getAttribute('og-shadow') ?? '').split(' ').filter(Boolean);
		if (host.shadowRoot) {
			// upgraded before the restore reached it: leave it as served, say so
			host.dispatchEvent(new CustomEvent('ogygia:restore-late', { bubbles: true, detail: { host: k } }));
			continue;
		}
		const shadow = host.attachShadow({ mode: 'open' });
		const own: CSSStyleSheet[] = [];
		for (const key of keys) {
			const s = sheet_for(key);
			if (typeof s === 'string') {
				const style = doc.createElement('style');
				style.textContent = s;
				shadow.appendChild(style);
			} else if (s) own.push(s);
		}
		if (own.length) {
			if (live) shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, ...own];
			else {
				// (on the root too: a morph that copies the host carries it to the copy's root)
				(shadow as ShadowRoot & { __og_pending?: CSSStyleSheet[] }).__og_pending = own;
				(W.__og_adopt ??= []).push({ shadow, sheets: own });
			}
		}
		// Svelte's children, wherever the render put them: tagged elements, and the node after each
		// tag comment (a text node the render dropped comes back from the mark)
		const children: { i: number; node: Node }[] = [];
		const tag = `${k}.`;
		for (const el of Array.from(host.querySelectorAll('[og-c]'))) {
			const v = el.getAttribute('og-c')!;
			if (v.startsWith(tag)) children.push({ i: Number(v.slice(tag.length)), node: el });
		}
		for (const mark of comments(host, `og-c ${tag}`)) {
			const rest = mark.data.slice(5 + tag.length);
			const i = Number(rest.slice(0, rest.indexOf(' ') === -1 ? rest.length : rest.indexOf(' ')));
			const is_text = rest.indexOf(' t') !== -1;
			const node = is_text ? fix_text(mark) : mark.nextSibling;
			if (!is_text) mark.remove();
			if (node) children.push({ i, node });
		}
		children.sort((a, b) => a.i - b.i);
		const mine = new Set(children.map((c) => c.node));
		// everything else directly under the host is the rendered tree
		for (const n of Array.from(host.childNodes)) if (!mine.has(n)) shadow.appendChild(n);
		for (const c of children) host.appendChild(c.node);
		for (const c of children) {
			if (c.node.nodeType === 1) {
				const el = c.node as Element;
				reset(el);
				el.removeAttribute('og-c');
			}
		}
		// deeper text inside the children the render trimmed or dropped
		for (const mark of comments(host, `og-t ${tag}`)) fix_text(mark);
		reset(host);
		host.removeAttribute('og-h');
		host.removeAttribute('og-shadow');
		host.removeAttribute('og-keep');
		verify(host, k);
		restored++;
	}
	return restored;
}

/** Adopt the sheets of roots restored outside the page, now that their hosts are in it (after a hole
 *  answer's insertion or a router swap, in the same task: no paint in between). A host the insertion
 *  discarded (a morph kept the live one) is dropped. */
export function restore_adopt(): void {
	const W = window as unknown as { __og_adopt?: { shadow: ShadowRoot; sheets: CSSStyleSheet[] }[] };
	const list = W.__og_adopt;
	if (!list?.length) return;
	W.__og_adopt = [];
	for (const { shadow, sheets } of list) {
		if (!shadow.host.isConnected) continue;
		shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, ...sheets];
	}
}
