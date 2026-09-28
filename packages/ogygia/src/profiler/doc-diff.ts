/**
 * WHAT CHANGES BETWEEN TWO RENDERS OF ONE PAGE: both documents split at their tags, lined up, and
 * every piece that differs grouped by what it is — an island's props (its region and its props
 * script change together), one attribute on one kind of tag (a random id stamped per render), or
 * the text inside a tag. A page the same but for a few such parts is a page to cache whole once
 * those parts stop changing. Hand-parsed (indexOf), no regex: a document can be megabytes.
 */

export interface DocDiffGroup {
	/** what changes, for a reader: `data-track on <a>`, `the Price island's props`, `text in <p>` */
	what: string;
	tag: string;
	attr?: string;
	island?: string;
	/** places it differs */
	count: number;
	/** one example, first render against the last */
	a: string;
	b: string;
	/** where your markup sets it (an attribute given a value from code), when a component file does */
	sources?: { file: string; line: number; code: string }[];
	/** an attribute no file of yours sets: a library stamps it as it renders */
	library?: boolean;
}

/** The lines of a component's markup that give `attr` a value from code on one of `tags`
 *  (`<a … data-track={id}>`): plain text search, the attribute's name as written. */
export function attr_sites(src: string, attr: string, tags: readonly string[]): { line: number; code: string }[] {
	const out: { line: number; code: string }[] = [];
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		// the attribute's whole name (`id` is not the end of `data-track-id`)
		let at = -1;
		// `attr={x}`, `attr="{x}"`, and Svelte's shorthand `{attr}` (a plain name only)
		for (const form of [`${attr}={`, `${attr}="{`, ...(attr.includes('-') ? [] : [`{${attr}}`])]) {
			let p = l.indexOf(form);
			while (p !== -1 && p > 0 && l[p - 1] !== ' ' && l[p - 1] !== '\t') p = l.indexOf(form, p + 1);
			if (p !== -1 && (at === -1 || p < at)) at = p;
		}
		if (at === -1) continue;
		// on one of the tags (opened before it on the line), or any tag when the line opens none
		// the tag opened before it — the whole name (`<a` is not the start of `<article`)
		const opens = tags.filter((t) => {
			let o = l.indexOf(`<${t}`);
			while (o !== -1 && o < at) {
				const next = l[o + t.length + 1];
				if (next === undefined || next === ' ' || next === '>' || next === '/' || next === '\t') return true;
				o = l.indexOf(`<${t}`, o + 1);
			}
			return false;
		});
		// another tag opened on the line: not this one; no tag opened: a multi-line tag's attribute line
		if (!opens.length && l.slice(0, at).includes('<')) continue;
		out.push({ line: i + 1, code: l.trim().length > 140 ? l.trim().slice(0, 139) + '…' : l.trim() });
	}
	return out;
}

export interface DocDiff {
	/** tag-delimited pieces of the later document */
	tokens: number;
	/** pieces that differ */
	differing: number;
	/** the documents lined up piece by piece (same count); else matched past small insertions */
	aligned: boolean;
	groups: DocDiffGroup[];
}

/** a document at its tags: each piece starts at a `<` */
function pieces(doc: string): string[] {
	const out: string[] = [];
	let at = 0;
	while (at < doc.length) {
		const next = doc.indexOf('<', at + 1);
		const end = next === -1 ? doc.length : next;
		out.push(doc.slice(at, end));
		at = end;
	}
	return out;
}

/** `<a href="x" data-track="1">text` → tag `a`, attributes, the text after the tag */
function parse(piece: string): { tag: string; attrs: Map<string, string>; text: string } {
	const attrs = new Map<string, string>();
	if (piece[0] !== '<') return { tag: 'text', attrs, text: piece };
	let i = 1;
	if (piece[i] === '/') i++;
	let j = i;
	while (j < piece.length && piece[j] !== ' ' && piece[j] !== '>' && piece[j] !== '/' && piece[j] !== '\n' && piece[j] !== '\t') j++;
	const tag = piece.slice(i, j).toLowerCase();
	const close = piece.indexOf('>', j);
	const head = close === -1 ? piece.slice(j) : piece.slice(j, close);
	// `name="value"` or `name='value'`
	let k = 0;
	while (k < head.length) {
		let eq = head.indexOf('=', k);
		while (eq !== -1 && head[eq + 1] !== '"' && head[eq + 1] !== "'") eq = head.indexOf('=', eq + 1);
		if (eq === -1) break;
		const q = head[eq + 1];
		let s = eq - 1;
		while (s >= 0 && head[s] !== ' ' && head[s] !== '\n' && head[s] !== '\t') s--;
		const name = head.slice(s + 1, eq);
		const endq = head.indexOf(q, eq + 2);
		if (endq === -1) break;
		attrs.set(name, head.slice(eq + 2, endq));
		k = endq + 1;
	}
	return { tag, attrs, text: close === -1 ? '' : piece.slice(close + 1) };
}

const clip = (s: string) => (s.length > 60 ? s.slice(0, 59) + '…' : s);

/**
 * The two documents' differences, grouped. `island_of(entry)` names an island by its entry URL (the
 * report's island rows). Undefined when they are the same, or differ too much to line up.
 */
export function doc_diff(a: string, b: string, island_of: (entry: string) => string | undefined = () => undefined, max_groups = 8): DocDiff | undefined {
	if (a === b) return undefined;
	const pa = pieces(a);
	const pb = pieces(b);
	const aligned = pa.length === pb.length;
	// which island each props script belongs to: its fingerprint → the region's entry, read off b
	const entry_of_fp = new Map<string, string>();
	const pairs: [string, string][] = [];
	if (aligned) {
		for (let i = 0; i < pb.length; i++) if (pa[i] !== pb[i]) pairs.push([pa[i], pb[i]]);
	} else {
		// past small insertions: on a mismatch, look a little ahead in each for the next match
		let i = 0;
		let j = 0;
		const AHEAD = 24;
		while (i < pa.length && j < pb.length) {
			if (pa[i] === pb[j]) {
				i++;
				j++;
				continue;
			}
			let moved = false;
			for (let d = 1; d <= AHEAD && !moved; d++) {
				if (j + d < pb.length && pa[i] === pb[j + d]) {
					// pieces the later render added
					for (let x = 0; x < d; x++) pairs.push(['', pb[j + x]]);
					j += d;
					moved = true;
				} else if (i + d < pa.length && pa[i + d] === pb[j]) {
					// pieces the later render dropped
					for (let x = 0; x < d; x++) pairs.push([pa[i + x], '']);
					i += d;
					moved = true;
				}
			}
			if (!moved) {
				pairs.push([pa[i], pb[j]]);
				i++;
				j++;
			}
			// too many differences to be "the same page but for a few parts" (a page that differs
			// everywhere; a tiny page's two pieces are not that)
			if (pairs.length > 50 && pairs.length > pb.length * 0.25) return undefined;
		}
		// what is left at the end of either
		for (; i < pa.length; i++) pairs.push([pa[i], '']);
		for (; j < pb.length; j++) pairs.push(['', pb[j]]);
		if (pairs.length > 50 && pairs.length > pb.length * 0.25) return undefined;
	}
	for (const p of pb) {
		if (!p.startsWith('<ogygia-region')) continue;
		const { attrs } = parse(p);
		const fp = attrs.get('data-og-fp');
		const entry = attrs.get('entry');
		if (fp && entry) entry_of_fp.set(fp, entry);
	}
	const groups = new Map<string, DocDiffGroup>();
	const add = (key: string, g: Omit<DocDiffGroup, 'count'>) => {
		const cur = groups.get(key);
		if (cur) cur.count++;
		else groups.set(key, { ...g, count: 1 });
	};
	for (const [x, y] of pairs) {
		// a piece only one render has: added, or dropped, by its tag
		if (!x || !y) {
			const only = parse(x || y);
			const verb = x ? 'dropped' : 'added';
			add(`${verb}\0${only.tag}`, { what: `<${only.tag}> ${verb} in the later render`, tag: only.tag, a: clip(x.slice(0, 60)), b: clip(y.slice(0, 60)) });
			continue;
		}
		// comment markers (`<!--r.439-->`, a renderer numbering its nodes): one group, whatever the number
		if (y.startsWith('<!--')) {
			const end = y.indexOf('-->');
			add('comment', { what: 'comment markers (<!--…-->)', tag: 'comment', a: clip(x.slice(0, x.indexOf('-->') + 3)), b: clip(end === -1 ? y : y.slice(0, end + 3)) });
			continue;
		}
		const py = parse(y);
		const px = parse(x);
		// an island: its region tag (a new fingerprint) and its props script change together
		if (py.tag === 'ogygia-region' || (py.tag === 'script' && py.attrs.has('data-ogygia-props'))) {
			const entry = py.tag === 'ogygia-region' ? py.attrs.get('entry') : entry_of_fp.get(py.attrs.get('data-ogygia-props') ?? '');
			const name = (entry && island_of(entry)) || 'an';
			// one place per island, not two (the region and its props are the same change)
			if (py.tag === 'script') continue;
			add(`island\0${name}`, { what: `the ${name} island's props`, tag: py.tag, island: name, a: clip(px.attrs.get('data-og-fp') ?? ''), b: clip(py.attrs.get('data-og-fp') ?? '') });
			continue;
		}
		// changed or added in the later render, and dropped from it
		const changed = [...py.attrs].filter(([k, v]) => px.attrs.get(k) !== v).map(([k]) => k);
		for (const k of px.attrs.keys()) if (!py.attrs.has(k)) changed.push(k);
		if (changed.length) {
			// one group per attribute, whatever tags carry it: one cause (a renderer stamping an id)
			for (const attr of changed) {
				const key = `attr\0${attr}`;
				const g = groups.get(key);
				if (g && !g.tag.split(', ').includes(py.tag)) g.tag += `, ${py.tag}`;
				add(key, { what: '', tag: py.tag, attr, a: clip(px.attrs.get(attr) ?? ''), b: clip(py.attrs.get(attr) ?? '') });
			}
		} else {
			add(`text\0${py.tag}`, { what: `text in <${py.tag}>`, tag: py.tag, a: clip(px.text.trim()), b: clip(py.text.trim()) });
		}
	}
	// an attribute group names its tags (the first few)
	for (const g of groups.values()) {
		if (!g.attr) continue;
		const tags = g.tag.split(', ');
		g.what = `${g.attr} on ${tags.slice(0, 3).map((t) => `<${t}>`).join(', ')}${tags.length > 3 ? ` and ${tags.length - 3} more` : ''}`;
	}
	return {
		tokens: pb.length,
		differing: pairs.length,
		aligned,
		groups: [...groups.values()].sort((m, n) => n.count - m.count).slice(0, max_groups)
	};
}
