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
		__og_sheets?: Map<string, { sheet: CSSStyleSheet | null; css: string }>;
		__og_adopt?: { shadow: ShadowRoot; sheets: CSSStyleSheet[] }[];
		__og_init?: ShadowRoot[];
		__og_class_watch?: { mo: MutationObserver; hosts: Set<Element> };
	};
	const sheets = (W.__og_sheets ??= new Map());
	// (a DOM without `CSS.escape` — jsdom — gets a quote-safe escape for the attribute selectors)
	const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.split('\\').join('\\\\').split('"').join('\\"'));
	// A constructed sheet can only be adopted by a root in the document that made it: a root made in
	// an answer's inert fragment (or an incoming page's parsed document) adopts once its host is in
	// the page — `restore_adopt()`, called right after the insertion, in the same task.
	const live = doc === document;
	let restored = 0;

	/**
	 * A KIT-HYDRATED page (csr=true) is hydrated by Kit's own start, which ogygia does not run — so
	 * the island hydrate's put-back of a component's class tokens (runtime/host-classes.ts) never
	 * runs there. Instead each restored custom element is watched once: Kit's hydrate writes its
	 * `class` whole, to exactly Svelte's tokens; the first write that leaves exactly those gets back
	 * every token it dropped (the component's, the render's `sc-*`), read from the value just before
	 * that write. A component only ever adds and removes its own tokens, so no later state of the
	 * host equals Svelte's alone. One observer for all of them; a host leaves the watch at that
	 * write, and the observer goes when the last one has.
	 */
	const watch_classes = live && document.querySelector('meta[name="ogygia-csr"][content="true"]') !== null;
	const watch = (el: Element) => {
		let w = W.__og_class_watch;
		if (!w) {
			const hosts = new Set<Element>();
			const mo = new MutationObserver((records) => {
				for (let i = 0; i < records.length; i++) {
					const host = records[i].target as Element & { __og_svelte_class?: string };
					if (!hosts.has(host)) continue;
					// this record's NEW value: the next record's old value for the same host, else the current one
					let now: string | null | undefined;
					for (let j = i + 1; j < records.length && now === undefined; j++) if (records[j].target === host) now = records[j].oldValue;
					if (now === undefined) now = host.getAttribute('class');
					if ((now ?? '') !== host.__og_svelte_class) continue;
					hosts.delete(host);
					const own = new Set((now ?? '').split(' '));
					for (const t of (records[i].oldValue ?? '').split(' ')) if (t && !own.has(t)) host.classList.add(t);
				}
				if (hosts.size === 0) {
					mo.disconnect();
					W.__og_class_watch = undefined;
				}
			});
			w = W.__og_class_watch = { mo, hosts };
		}
		w.hosts.add(el);
		w.mo.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
	};

	// 0. head assets an answer carries (`data-og-head`): into the page's head once per key
	if (root !== document && (root as ParentNode).querySelectorAll) {
		for (const el of Array.from((root as ParentNode).querySelectorAll('[data-og-head]'))) {
			const key = el.getAttribute('data-og-head')!;
			if (head.querySelector(`[data-og-head="${esc(key)}"]`)) el.remove();
			else head.appendChild(el);
		}
	}

	const sheet_for = (key: string): { sheet: CSSStyleSheet | null; css: string } | null => {
		const have = sheets.get(key);
		if (have) return have;
		const sel = `template[data-og-head="${esc(key)}"]`;
		// (an incoming page carries its sheets in its own head until the swap)
		const tpl = ((doc !== document && doc.head?.querySelector(sel)) || head.querySelector(sel)) as HTMLTemplateElement | null;
		if (!tpl) return null;
		const css = tpl.content.textContent ?? '';
		let sheet: CSSStyleSheet | null = null;
		try {
			sheet = new CSSStyleSheet();
			sheet.replaceSync(css);
		} catch {
			// no constructable stylesheets: a <style> per root
			sheet = null;
		}
		const made = { sheet, css };
		sheets.set(key, made);
		return made;
	};

	/** Attributes back to Svelte's. A custom element's `class` has two owners — Svelte, and the
	 *  component, which may put state on its own host — so there it becomes Svelte's tokens PLUS the
	 *  ones the render added, and Svelte's are recorded on the element (`__og_svelte_class`): the
	 *  island's hydrate puts the component's back after Svelte writes `class` whole
	 *  (runtime/host-classes.ts). Unless the render kept `class` as its own (`og-keep`). */
	const reset = (el: Element) => {
		const r = el.getAttribute('og-r');
		const custom = el.localName.indexOf('-') !== -1 && (' ' + (el.getAttribute('og-keep') ?? '') + ' ').indexOf(' class ') === -1;
		let svelte_class: string | null | undefined;
		if (r) {
			try {
				const diff = JSON.parse(r) as Record<string, string | null>;
				for (const name in diff) {
					const v = diff[name];
					if (custom && name === 'class') {
						svelte_class = v;
						const own = new Set((v ?? '').split(' '));
						let theirs = '';
						for (const t of Array.from(el.classList)) if (!own.has(t)) theirs += ' ' + t;
						const merged = ((v ?? '') + theirs).trim();
						if (merged) el.setAttribute('class', merged);
						else el.removeAttribute('class');
					} else if (v === null) el.removeAttribute(name);
					else el.setAttribute(name, v);
				}
			} catch {
				// a mangled diff: leave the attributes
			}
		}
		// (no class in the diff: the render left it as Svelte's)
		if (custom) {
			(el as Element & { __og_svelte_class?: string }).__og_svelte_class = svelte_class === undefined ? (el.getAttribute('class') ?? '') : (svelte_class ?? '');
			if (watch_classes) watch(el);
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
			// A web-component host may carry more than Svelte gave it: extra attributes, and class
			// tokens its own component adds to its host (a theme, a position) — Svelte's tokens must all
			// be there. A plain element compares exactly.
			const custom = ex.localName.indexOf('-') !== -1;
			for (const attr of Array.from(ex.attributes)) {
				if (custom && attr.name === 'class' ? within(attr.value, ey.getAttribute('class')) : norm(attr.name, attr.value) === norm(attr.name, ey.getAttribute(attr.name))) continue;
				return `${here} <${ex.localName}>: Svelte has ${attr.name}="${attr.value}", the restored markup has ${ey.hasAttribute(attr.name) ? `"${ey.getAttribute(attr.name)}"` : 'none'}`;
			}
			if (!custom)
				for (const attr of Array.from(ey.attributes)) if (!ex.hasAttribute(attr.name) && norm(attr.name, attr.value) !== null) return `${here} <${ex.localName}>: the restored markup adds ${attr.name}="${attr.value}"`;
			const deeper = differ(x, y, `${here} <${ex.localName}>`);
			if (deeper) return deeper;
		}
		return null;
	};
	/** An attribute as it matters, not as a serializer wrote it: `class` as its set of tokens, `style`
	 *  as its declarations, an empty value as absent (Svelte's hydration reads neither; a render's
	 *  serializer rewrites both). */
	const norm = (name: string, value: string | null): string | null => {
		if (value === null || value.trim() === '') return name === 'class' || name === 'style' ? null : value;
		if (name === 'class') return value.split(/\s+/).filter(Boolean).sort().join(' ');
		if (name === 'style')
			return value
				.split(';')
				.map((d) => {
					const c = d.indexOf(':');
					return c === -1 ? d.trim() : `${d.slice(0, c).trim().toLowerCase()}:${d.slice(c + 1).trim().replace(/\s+/g, ' ')}`;
				})
				.filter(Boolean)
				.join(';');
		return value;
	};
	/** Every class token of `want` is in `got`. */
	const within = (want: string, got: string | null): boolean => {
		const have = new Set((got ?? '').split(/\s+/));
		for (const t of want.split(/\s+/)) if (t && !have.has(t)) return false;
		return true;
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
	// …in the root, and in every open shadow root already there (a declarative one the page shipped:
	// `querySelectorAll` never enters them), deeper roots after the ones holding them
	const scopes: ParentNode[] = [root as ParentNode];
	for (let q = 0; q < scopes.length; q++) {
		const walk = doc.createTreeWalker(scopes[q] as Node, 1 /* SHOW_ELEMENT */);
		for (let n = walk.nextNode(); n; n = walk.nextNode()) {
			const sr = (n as Element).shadowRoot;
			if (sr && sr.mode === 'open') scopes.push(sr);
		}
	}
	for (const scope of scopes) swap_stand_ins(scope);

	// 2. the planned hosts, innermost first (a deeper shadow root's hosts before its host's)
	const hosts: Element[] = [];
	for (const scope of scopes) hosts.push(...Array.from(scope.querySelectorAll('[og-h]')));
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
		// A root attached in a document without a browsing context (an answer's inert fragment, an
		// incoming page) gets no custom element registry, and keeps none after the insertion: nothing
		// inside it would upgrade. `restore_adopt()` initializes it once its host is in the page.
		if (!live) (W.__og_init ??= []).push(shadow);
		const own: CSSStyleSheet[] = [];
		// (a DOM without adoptable sheets — jsdom has the constructor but no adoptedStyleSheets — gets a
		// <style> per root, like a browser without constructable sheets)
		const adoptable = Array.isArray(shadow.adoptedStyleSheets);
		for (const key of keys) {
			const s = sheet_for(key);
			if (!s) continue;
			if (s.sheet && adoptable) own.push(s.sheet);
			else {
				const style = doc.createElement('style');
				style.textContent = s.css;
				shadow.appendChild(style);
			}
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
	const W = window as unknown as { __og_adopt?: { shadow: ShadowRoot; sheets: CSSStyleSheet[] }[]; __og_init?: ShadowRoot[] };
	// first: roots attached outside the page get the page's registry, so what is inside them upgrades
	// (a browser without scoped registries never nulls it, and has no `initialize`)
	const bare = W.__og_init;
	if (bare?.length) {
		W.__og_init = [];
		const ce = customElements as CustomElementRegistry & { initialize?: (root: Node) => void };
		for (const root of bare)
			if (root.host.isConnected && (root as ShadowRoot & { customElementRegistry?: unknown }).customElementRegistry === null) ce.initialize?.(root);
	}
	const list = W.__og_adopt;
	if (!list?.length) return;
	W.__og_adopt = [];
	for (const { shadow, sheets } of list) {
		if (!shadow.host.isConnected) continue;
		shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, ...sheets];
	}
}
