/**
 * THE PAGE'S WEIGHT — every file the rendered document makes the browser fetch at start, found in
 * the HTML and weighed through the app. Not only the islands: the page's own `<script>`s, every
 * `modulepreload` (a Kit-hydrated page lists its whole start graph there), the modules an inline
 * script imports (Kit's start/app entries), each module's STATIC imports followed to the end,
 * stylesheets (and which of them block the first paint), fonts and images preloaded or in the
 * markup. A page that ships 6 MB of JS shows 6 MB here, whatever made it.
 *
 * Two halves: `scan_assets` (pure: HTML in, references out — string scanning, no regex) and
 * `weigh_assets` (fetches each once through the app, decoded + gzip-estimated sizes, follows static
 * imports, bounded in time and count). The score (score.ts) reads the totals.
 */

import { find_unscoped, type UnscopedStyles } from '../unscoped-css.js';

export type AssetKind = 'script' | 'style' | 'font' | 'image' | 'other';

export interface AssetRef {
	url: string;
	kind: AssetKind;
	/** the browser must have it before the first paint (a head stylesheet, a classic sync script) */
	blocking: boolean;
	/** how the document asks for it (`island`: the runtime loads it to wake an island) */
	via: 'script' | 'modulepreload' | 'preload' | 'stylesheet' | 'inline-import' | 'img' | 'static-import' | 'island' | 'route-node' | 'runtime-phase';
	/** loads later, on demand (an island that wakes when visible / on interaction), not at start */
	lazy?: boolean;
	/** the ogygia runtime's own script (`data-ogygia-runtime`): the parts it loads itself are its own */
	runtime?: true;
	/** a part of the ogygia runtime it loads on demand as islands wake (and what that part imports) */
	phase?: true;
}

export interface WeighedAsset extends AssetRef {
	/** decoded bytes (what the browser parses) */
	bytes: number;
	/** bytes on the wire: the response's own when it was compressed, else a gzip estimate */
	wire: number;
	/** what the build put in it (its source files and packages, readable), when the build said */
	contains?: string[];
}

export interface PageAssets {
	assets: WeighedAsset[];
	/** components whose styles shipped WITHOUT their scope (the build's fallback marker, in a
	 *  stylesheet or an inline `<style>`): their rules apply to the whole page */
	unscoped?: (UnscopedStyles & { in: string })[];
	/** references that could not be weighed (a 404, a timeout, the budget ran out) */
	missed: string[];
	/** the HTML itself */
	html: { bytes: number; wire: number };
	/** inline `<script>` / `<style>` text in the document, decoded bytes */
	inline: { script: number; style: number };
	totals: {
		js: number;
		js_wire: number;
		css: number;
		css_wire: number;
		font: number;
		image: number;
		/** every byte at start, on the wire (HTML included) */
		wire: number;
		/** JS that loads later, on demand (lazy islands), decoded — not in `js` */
		lazy_js: number;
		/** blocking the first paint: stylesheets + classic sync scripts, decoded */
		blocking: number;
		blocking_count: number;
		js_files: number;
	};
}

// ── the scanner ──

/** Attributes of one start tag (`<tag a="1" b c='2'>`), names lower-cased; valueless → ''. */
export function tag_attrs(tag: string): Map<string, string> {
	const out = new Map<string, string>();
	let i = 1;
	// skip the tag name
	while (i < tag.length && !is_space(tag.charCodeAt(i)) && tag[i] !== '>' && tag[i] !== '/') i++;
	while (i < tag.length) {
		while (i < tag.length && (is_space(tag.charCodeAt(i)) || tag[i] === '/')) i++;
		if (i >= tag.length || tag[i] === '>') break;
		const ns = i;
		while (i < tag.length && !is_space(tag.charCodeAt(i)) && tag[i] !== '=' && tag[i] !== '>' && tag[i] !== '/') i++;
		const name = tag.slice(ns, i).toLowerCase();
		while (i < tag.length && is_space(tag.charCodeAt(i))) i++;
		let value = '';
		if (tag[i] === '=') {
			i++;
			while (i < tag.length && is_space(tag.charCodeAt(i))) i++;
			const q = tag[i];
			if (q === '"' || q === "'") {
				const end = tag.indexOf(q, i + 1);
				value = tag.slice(i + 1, end === -1 ? tag.length : end);
				i = end === -1 ? tag.length : end + 1;
			} else {
				const vs = i;
				while (i < tag.length && !is_space(tag.charCodeAt(i)) && tag[i] !== '>') i++;
				value = tag.slice(vs, i);
			}
		}
		if (name && !out.has(name)) out.set(name, decode_entities(value));
	}
	return out;
}

function is_space(c: number): boolean {
	return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

function decode_entities(s: string): string {
	if (s.indexOf('&') === -1) return s;
	return s.split('&amp;').join('&').split('&quot;').join('"').split('&#39;').join("'");
}

const FONT_EXT = new Set(['woff', 'woff2', 'ttf', 'otf']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico']);

function ext_of(url: string): string {
	let end = url.length;
	const q = url.indexOf('?');
	if (q !== -1) end = q;
	const h = url.indexOf('#');
	if (h !== -1 && h < end) end = h;
	const path = url.slice(0, end);
	const dot = path.lastIndexOf('.');
	return dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
}

function kind_of(url: string, as?: string): AssetKind {
	if (as === 'script' || as === 'module') return 'script';
	if (as === 'style') return 'style';
	if (as === 'font') return 'font';
	if (as === 'image') return 'image';
	const e = ext_of(url);
	if (e === 'js' || e === 'mjs') return 'script';
	if (e === 'css') return 'style';
	if (FONT_EXT.has(e)) return 'font';
	if (IMG_EXT.has(e)) return 'image';
	return 'other';
}

/** `import("x")` / `import('x')` specifiers in a script's text (Kit's inline start). */
export function dynamic_imports(text: string): string[] {
	const out: string[] = [];
	let at = text.indexOf('import(');
	while (at !== -1) {
		let i = at + 7;
		while (i < text.length && is_space(text.charCodeAt(i))) i++;
		const q = text[i];
		if (q === '"' || q === "'" || q === '`') {
			const end = text.indexOf(q, i + 1);
			if (end !== -1) {
				const spec = text.slice(i + 1, end);
				if (spec && spec.indexOf('${') === -1) out.push(spec);
			}
		}
		at = text.indexOf('import(', at + 7);
	}
	return out;
}

/**
 * The STATIC imports of a bundled module (`import{a}from"./x.js"`, `import"./y.js"`,
 * `export*from"./z.js"`): specifiers after `from` / a bare `import` that look like module paths
 * (relative or absolute, ending in .js/.mjs). Bundler output writes them plainly; a string that
 * merely contains such text inflates nothing that does not exist — every hit is fetched, and a
 * miss is dropped.
 */
export function static_imports(code: string): string[] {
	const out = new Set<string>();
	const grab = (from: number) => {
		let i = from;
		while (i < code.length && is_space(code.charCodeAt(i))) i++;
		const q = code[i];
		if (q !== '"' && q !== "'") return;
		const end = code.indexOf(q, i + 1);
		if (end === -1 || end - i > 400) return;
		const spec = code.slice(i + 1, end);
		const e = ext_of(spec);
		if ((spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) && (e === 'js' || e === 'mjs')) out.add(spec);
	};
	for (const word of ['from', 'import']) {
		let at = code.indexOf(word);
		while (at !== -1) {
			const before = at > 0 ? code.charCodeAt(at - 1) : 32;
			// a whole word: not `xfrom`, not `.import`
			const ok = !(is_ident(before) || before === 46);
			const next = code[at + word.length];
			if (ok && next !== '(' && next !== undefined && !is_ident(code.charCodeAt(at + word.length))) grab(at + word.length);
			at = code.indexOf(word, at + word.length);
		}
	}
	return [...out];
}

function is_ident(c: number): boolean {
	return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

/**
 * A Kit-hydrated page's route nodes: its inline start script passes `node_ids: [0, 5]` to
 * `kit.start`, and `app.js` imports each node on demand (`import("../nodes/5.<hash>.js")`) — the
 * page's OWN code, the heaviest part, reachable only through that dynamic import. Empty when the
 * page is not Kit-hydrated.
 */
export function kit_node_ids(script: string): number[] {
	const at = script.indexOf('node_ids:');
	if (at === -1) return [];
	const open = script.indexOf('[', at);
	const close = script.indexOf(']', open);
	if (open === -1 || close === -1 || open - at > 20) return [];
	const out: number[] = [];
	for (const part of script.slice(open + 1, close).split(',')) {
		const n = Number(part.trim());
		if (Number.isInteger(n) && n >= 0) out.push(n);
	}
	return out;
}

/** Every file the document asks for at start, in document order, deduped by URL (the first,
 *  strongest ask wins: a blocking stylesheet stays blocking). Inline script/style bytes counted. */
export function scan_assets(html: string): { refs: AssetRef[]; inline: { script: number; style: number }; kit_nodes: number[] } {
	const refs: AssetRef[] = [];
	const seen = new Set<string>();
	const add = (url: string | undefined, kind: AssetKind, via: AssetRef['via'], blocking: boolean) => {
		if (!url) return;
		const u = url.trim();
		if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#') || u.startsWith('javascript:')) return;
		if (seen.has(u)) return;
		seen.add(u);
		refs.push({ url: u, kind, blocking, via });
	};
	const inline = { script: 0, style: 0 };
	let kit_nodes: number[] = [];
	const head_end = html.indexOf('</head>');
	let i = html.indexOf('<');
	while (i !== -1) {
		const c = html.charCodeAt(i + 1);
		// comments: skip whole
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end === -1 ? -1 : html.indexOf('<', end + 3);
			continue;
		}
		if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) {
			i = html.indexOf('<', i + 1);
			continue;
		}
		const close = html.indexOf('>', i);
		if (close === -1) break;
		const tag = html.slice(i, close + 1);
		const name = tag_name(tag);
		const in_head = head_end !== -1 && i < head_end;
		if (name === 'script') {
			const a = tag_attrs(tag);
			const end = html.indexOf('</script', close);
			const body = end === -1 ? '' : html.slice(close + 1, end);
			const type = (a.get('type') ?? '').toLowerCase();
			const is_js = type === '' || type === 'module' || type === 'text/javascript' || type === 'application/javascript';
			if (a.has('src')) {
				if (is_js) {
					const n = refs.length;
					add(a.get('src'), 'script', 'script', type !== 'module' && !a.has('async') && !a.has('defer') && in_head);
					if (refs.length > n && a.has('data-ogygia-runtime')) refs[n].runtime = true;
				}
			} else if (is_js) {
				inline.script += body.length;
				for (const spec of dynamic_imports(body)) add(spec, 'script', 'inline-import', false);
				if (!kit_nodes.length) kit_nodes = kit_node_ids(body);
				if (type === 'module') for (const spec of static_imports(body)) add(spec, 'script', 'inline-import', false);
			}
			i = end === -1 ? -1 : html.indexOf('<', end + 8);
			continue;
		}
		if (name === 'style') {
			const end = html.indexOf('</style', close);
			if (end !== -1) inline.style += end - close - 1;
			i = end === -1 ? -1 : html.indexOf('<', end + 7);
			continue;
		}
		if (name === 'link') {
			const a = tag_attrs(tag);
			const rel = words((a.get('rel') ?? '').toLowerCase());
			const href = a.get('href');
			if (rel.includes('stylesheet')) {
				const media = (a.get('media') ?? '').toLowerCase();
				// a print / non-matching media sheet does not block; `disabled` loads nothing
				if (!a.has('disabled')) add(href, 'style', 'stylesheet', media === '' || media === 'all' || media === 'screen');
			} else if (rel.includes('modulepreload')) add(href, 'script', 'modulepreload', false);
			else if (rel.includes('preload')) add(href, kind_of(href ?? '', (a.get('as') ?? '').toLowerCase()), 'preload', false);
			else if (rel.includes('icon')) add(href, 'image', 'img', false);
		} else if (name === 'img') {
			const a = tag_attrs(tag);
			// a lazy image loads when it nears the viewport, not at start
			if ((a.get('loading') ?? '').toLowerCase() !== 'lazy') add(a.get('src'), 'image', 'img', false);
		}
		i = html.indexOf('<', close + 1);
	}
	return { refs, inline, kit_nodes };
}

function words(s: string): string[] {
	const out: string[] = [];
	let w = '';
	for (let i = 0; i < s.length; i++) {
		if (is_space(s.charCodeAt(i))) {
			if (w) out.push(w);
			w = '';
		} else w += s[i];
	}
	if (w) out.push(w);
	return out;
}

function tag_name(tag: string): string {
	let e = 1;
	while (e < tag.length && !is_space(tag.charCodeAt(e)) && tag[e] !== '>' && tag[e] !== '/') e++;
	return tag.slice(1, e).toLowerCase();
}

// ── the weigher ──

export interface Weight {
	bytes: number;
	wire: number;
	/** a module's static imports (resolved to absolute paths), for the walk */
	imports?: string[];
	/** its dynamic imports (resolved) — followed only where the page names them (Kit's route nodes) */
	dynamic?: string[];
	/** a stylesheet's unscoped fallbacks (see unscoped-css.ts) */
	unscoped?: UnscopedStyles[];
}

/** Resolve a reference against the page (and a module's import against its module). */
export function resolve_ref(ref: string, base: string): string | null {
	try {
		const u = new URL(ref, base);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u.href;
	} catch {
		return null;
	}
}

export interface WeighOptions {
	/** the page URL references resolve against */
	page_url: string;
	fetch_url: (url: string) => Promise<Response>;
	/** per-URL cache across reports (a hashed asset never changes) */
	cache: Map<string, Weight | null>;
	/** gzip a body to estimate its wire size (node:zlib in the profiler; absent = decoded size) */
	gzip?: (bytes: Uint8Array) => number;
	budget_ms?: number;
	max_files?: number;
	/** the document the refs came from */
	html: string;
	/** files the HTML does not name but the page loads: islands' modules (lazy ones marked) */
	extra?: AssetRef[];
	/** what the build put in a file (by its absolute URL), for naming a hashed chunk */
	contents_of?: (url: string) => string[] | null;
}

export async function weigh_assets(opts: WeighOptions): Promise<PageAssets> {
	const { refs, inline, kit_nodes } = scan_assets(opts.html);
	// Kit's route nodes, as file-name marks (`/nodes/5.`) to find among app.js's dynamic imports
	const node_marks = kit_nodes.map((n) => `/nodes/${n}.`);
	const deadline = Date.now() + (opts.budget_ms ?? 6000);
	const max_files = opts.max_files ?? 400;
	const origin = new URL(opts.page_url).origin;
	// the queue: document refs, then each module's static imports as they are found
	const queue: AssetRef[] = [];
	const queued = new Set<string>();
	const push = (r: AssetRef) => {
		const abs = resolve_ref(r.url, opts.page_url);
		if (!abs || queued.has(abs)) return;
		queued.add(abs);
		queue.push({ ...r, url: abs });
	};
	for (const r of refs) push(r);
	// at-start islands before lazy ones, so a module both need is counted as at-start
	const extra = opts.extra ?? [];
	for (const r of extra) if (!r.lazy) push(r);
	for (const r of extra) if (r.lazy) push(r);
	const assets: WeighedAsset[] = [];
	const missed: string[] = [];
	let at = 0;
	const worker = async () => {
		while (at < queue.length && Date.now() < deadline && assets.length + missed.length < max_files) {
			const r = queue[at++];
			let w = opts.cache.get(r.url);
			if (w === undefined) {
				w = await weigh_one(r, opts, deadline, origin);
				opts.cache.set(r.url, w);
			}
			if (!w) {
				missed.push(r.url);
				continue;
			}
			const contains = r.kind === 'script' || r.kind === 'style' ? opts.contents_of?.(r.url) : null;
			assets.push({ ...r, bytes: w.bytes, wire: w.wire, ...(contains?.length ? { contains } : {}) });
			// a module's imports load with it: lazy with a lazy parent
			if (r.kind === 'script' && w.imports) for (const spec of w.imports) push({ url: spec, kind: 'script', blocking: false, via: 'static-import', ...(r.lazy ? { lazy: true } : {}), ...(r.phase ? { phase: true } : {}) });
			// the ogygia runtime's on-demand parts (hydration and the rest, loaded as islands wake): its
			// own, on demand — the visit tells which loaded at start, and they read as the runtime's,
			// never as code "other scripts fetched"
			if (r.runtime && w.dynamic) for (const spec of w.dynamic) push({ url: spec, kind: 'script', blocking: false, via: 'runtime-phase', lazy: true, phase: true });
			// the route nodes this page starts with (and only those: app.js imports every route's)
			if (node_marks.length && w.dynamic)
				for (const spec of w.dynamic) if (node_marks.some((m) => spec.includes(m))) push({ url: spec, kind: 'script', blocking: false, via: 'route-node' });
		}
	};
	// workers pick up imports as they are found: keep going while the queue grows
	while (at < queue.length && Date.now() < deadline && assets.length + missed.length < max_files) {
		await Promise.all(Array.from({ length: Math.min(6, queue.length - at) }, worker));
	}
	for (let k = at; k < queue.length; k++) missed.push(queue[k].url);

	const html_bytes = byte_length(opts.html);
	const html_wire = opts.gzip ? opts.gzip(new TextEncoder().encode(opts.html)) : html_bytes;
	const t = { js: 0, js_wire: 0, css: 0, css_wire: 0, font: 0, image: 0, wire: html_wire, lazy_js: 0, blocking: 0, blocking_count: 0, js_files: 0 };
	for (const a of assets) {
		if (a.lazy) {
			if (a.kind === 'script') t.lazy_js += a.bytes;
			continue;
		}
		t.wire += a.wire;
		if (a.kind === 'script') {
			t.js += a.bytes;
			t.js_wire += a.wire;
			t.js_files++;
		} else if (a.kind === 'style') {
			t.css += a.bytes;
			t.css_wire += a.wire;
		} else if (a.kind === 'font') t.font += a.wire;
		else if (a.kind === 'image') t.image += a.wire;
		if (a.blocking) {
			t.blocking += a.bytes;
			t.blocking_count++;
		}
	}
	// the build's unscoped-fallback markers: in the document's inline <style>s, then in each sheet
	const unscoped: (UnscopedStyles & { in: string })[] = find_unscoped(inline_style_text(opts.html)).map((u) => ({ ...u, in: 'the document' }));
	for (const a of assets) if (a.kind === 'style') for (const u of opts.cache.get(a.url)?.unscoped ?? []) if (!unscoped.some((x) => x.file === u.file)) unscoped.push({ ...u, in: a.url });
	return { assets: assets.sort((x, y) => y.bytes - x.bytes), missed, ...(unscoped.length ? { unscoped } : {}), html: { bytes: html_bytes, wire: html_wire }, inline, totals: t };
}

/** The text of every inline `<style>` in the document (only there is a marker the build's: a page
 *  that quotes one in its content is not a fallback). */
function inline_style_text(html: string): string {
	let out = '';
	let at = html.indexOf('<style');
	while (at !== -1) {
		const open = html.indexOf('>', at);
		const close = open === -1 ? -1 : html.indexOf('</style', open);
		if (close === -1) break;
		out += html.slice(open + 1, close) + '\n';
		at = html.indexOf('<style', close);
	}
	return out;
}

export interface AssetChange {
	/** the file's name now (or then, for one that is gone) */
	name: string;
	/** what the build put in it — the identity across builds (hashed names change every build) */
	contains?: string[];
	a: number;
	b: number;
	lazy?: boolean;
}

export interface AssetsDiff {
	/** JS at start, decoded, then → now */
	js: { a: number; b: number };
	lazy_js: { a: number; b: number };
	added: AssetChange[];
	removed: AssetChange[];
	grew: AssetChange[];
	shrank: AssetChange[];
	/** the same file, now loaded at start (it loaded later before: an island's wake changed) */
	to_start: AssetChange[];
	/** the same file, now loaded later (it loaded at start before) */
	to_later: AssetChange[];
}

const MIN_CHANGE = 5 * 1024;

/**
 * WHAT CHANGED IN THE PAGE'S JS between two weighings (two builds): the files new, gone, grown and
 * shrunk. Hashed names change every build, so a file is known by what the build put in it (its
 * source files and packages, `contains`), and by its URL only when the build said nothing. Changes
 * under 5 KB are left out; each list is heaviest first.
 */
/** What a diff needs of a weighing: the report's JSON carries this much too (a CI compare). */
export interface WeighedLike {
	assets: { url: string; kind: string; bytes: number; contains?: string[]; lazy?: boolean }[];
	totals: { js: number; lazy_js: number };
}

export function assets_diff(a: WeighedLike, b: WeighedLike): AssetsDiff {
	type W = WeighedLike['assets'][number];
	const key = (x: W) => (x.contains?.length ? 'c:' + [...x.contains].sort().join('|') : 'u:' + x.url);
	const scripts = (p: WeighedLike) => {
		const m = new Map<string, W>();
		for (const x of p.assets) if (x.kind === 'script') m.set(key(x), x);
		return m;
	};
	const A = scripts(a);
	const B = scripts(b);
	const name = (x: W) => {
		const q = x.url.indexOf('?');
		const path = q === -1 ? x.url : x.url.slice(0, q);
		return path.slice(path.lastIndexOf('/') + 1);
	};
	const change = (x: W, av: number, bv: number): AssetChange => ({ name: name(x), ...(x.contains?.length ? { contains: x.contains.slice(0, 4) } : {}), a: av, b: bv, ...(x.lazy ? { lazy: true } : {}) });
	const added: AssetChange[] = [];
	const removed: AssetChange[] = [];
	const grew: AssetChange[] = [];
	const shrank: AssetChange[] = [];
	const to_start: AssetChange[] = [];
	const to_later: AssetChange[] = [];
	for (const [k, x] of B) {
		const was = A.get(k);
		if (!was) {
			if (x.bytes >= MIN_CHANGE) added.push(change(x, 0, x.bytes));
			continue;
		}
		if (x.bytes - was.bytes >= MIN_CHANGE) grew.push(change(x, was.bytes, x.bytes));
		else if (was.bytes - x.bytes >= MIN_CHANGE) shrank.push(change(x, was.bytes, x.bytes));
		// the same file changing WHEN it loads: what a changed island wake does (weight the same)
		if (!!was.lazy !== !!x.lazy && x.bytes >= MIN_CHANGE) (x.lazy ? to_later : to_start).push(change(x, was.bytes, x.bytes));
	}
	for (const [k, x] of A) if (!B.has(k) && x.bytes >= MIN_CHANGE) removed.push(change(x, x.bytes, 0));
	const by = (s: AssetChange[]) => s.sort((p, q) => Math.abs(q.b - q.a) - Math.abs(p.b - p.a)).slice(0, 5);
	const big = (s: AssetChange[]) => s.sort((p, q) => q.b - p.b).slice(0, 5);
	return {
		js: { a: a.totals.js, b: b.totals.js },
		lazy_js: { a: a.totals.lazy_js, b: b.totals.lazy_js },
		added: by(added),
		removed: by(removed),
		grew: by(grew),
		shrank: by(shrank),
		to_start: big(to_start),
		to_later: big(to_later)
	};
}

export interface RuntimeScripts {
	files: number;
	/** decoded */
	bytes: number;
	/** on the wire (a third of decoded where the browser saw none: a cached file) */
	wire: number;
	/** by who serves them: `this app`, or a CDN package / host */
	by: { who: string; files: number; bytes: number }[];
	/** of this app's, the island entry files (`og-region.<id>.…js`): islands no HTML named — the ones
	 *  a hole's answer brought */
	island_entries?: number;
}

/**
 * SCRIPTS LOADED AT RUNTIME — what the browser fetched that neither the HTML nor any module's
 * imports name: a script that loads more scripts (a CDN component library fetching its parts, a tag
 * manager, a runtime's on-demand chunk). The server cannot see them coming; the profiler user's own
 * visit saw them. `until`: the end of "at start" on the visit's clock (a lazy island woken by a
 * scroll later does not count). Null when there are none.
 */
export function runtime_scripts(
	assets: readonly { url: string }[],
	resources: readonly { url: string; type: string; start: number; size?: number; transfer?: number }[],
	origin: string,
	until: number
): RuntimeScripts | null {
	const named = new Set(assets.map((a) => a.url));
	const by = new Map<string, { who: string; files: number; bytes: number }>();
	let files = 0;
	let bytes = 0;
	let wire = 0;
	let entries = 0;
	const seen = new Set<string>();
	for (const r of resources) {
		if (r.type !== 'script' || r.start > until || named.has(r.url) || seen.has(r.url) || r.url.includes('/__profiler/')) continue;
		seen.add(r.url);
		const size = r.size ?? 0;
		files++;
		bytes += size;
		wire += r.transfer || Math.round(size / 3);
		const who = serves(r.url, origin);
		const g = by.get(who) ?? { who, files: 0, bytes: 0 };
		g.files++;
		g.bytes += size;
		by.set(who, g);
		if (who === 'this app' && r.url.slice(r.url.lastIndexOf('/') + 1).startsWith('og-region.')) entries++;
	}
	return files ? { files, bytes, wire, by: [...by.values()].sort((a, b) => b.bytes - a.bytes), ...(entries ? { island_entries: entries } : {}) } : null;
}

/** `this app`, a CDN package (`@scope/name` after `/npm/`), or the host. */
function serves(url: string, origin: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return 'unknown';
	}
	if (u.origin === origin) return 'this app';
	const at = u.pathname.indexOf('/npm/');
	if (at !== -1) {
		const parts = u.pathname.slice(at + 5).split('/');
		const pkg = parts[0].startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0];
		const bare = pkg.lastIndexOf('@') > 0 ? pkg.slice(0, pkg.lastIndexOf('@')) : pkg;
		return `${u.host} ${bare}`;
	}
	return u.host;
}

function byte_length(s: string): number {
	// UTF-8 length without allocating: ASCII 1, BMP 2–3, surrogate pairs 4
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

async function weigh_one(r: AssetRef, opts: WeighOptions, deadline: number, origin: string): Promise<Weight | null> {
	const left = deadline - Date.now();
	if (left < 100) return null;
	try {
		const res = await Promise.race([
			opts.fetch_url(r.url.startsWith(origin) ? r.url.slice(origin.length) || '/' : r.url),
			new Promise<null>((ok) => setTimeout(() => ok(null), left))
		]);
		if (!res || !res.ok) return null;
		const enc = res.headers.get('content-encoding');
		const len = Number(res.headers.get('content-length'));
		const buf = new Uint8Array(await res.arrayBuffer());
		// the body is decoded by fetch; a compressed response's content-length is its wire size
		const wire = enc && Number.isFinite(len) && len > 0 ? len : opts.gzip && buf.byteLength > 256 ? opts.gzip(buf) : buf.byteLength;
		const w: Weight = { bytes: buf.byteLength, wire };
		if (r.kind === 'script') {
			const code = new TextDecoder().decode(buf);
			const imports: string[] = [];
			for (const spec of static_imports(code)) {
				const abs = resolve_ref(spec, r.url);
				if (abs) imports.push(abs);
			}
			if (imports.length) w.imports = imports;
			const dynamic: string[] = [];
			for (const spec of dynamic_imports(code)) {
				const abs = resolve_ref(spec, r.url);
				if (abs) dynamic.push(abs);
			}
			if (dynamic.length) w.dynamic = dynamic;
		} else if (r.kind === 'style') {
			const u = find_unscoped(new TextDecoder().decode(buf));
			if (u.length) w.unscoped = u;
		}
		return w;
	} catch {
		return null;
	}
}
