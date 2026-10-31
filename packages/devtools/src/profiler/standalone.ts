/**
 * STANDALONE REPORT — one HTML file that opens from disk, islands and all.
 *
 * The report page is an ogygia document: server markup, a runtime `<script type="module" src>`,
 * `<ogygia-region entry="…">` islands whose chunks are `import()`ed by URL, stylesheet links. None
 * of that survives `file://`. This turns it into a single file:
 *
 *   • every stylesheet link becomes a `<style>`;
 *   • every JS chunk the page can reach (the runtime, each island entry, and everything they
 *     import, transitively) is fetched once, its relative imports rewritten to bare `og:<path>`
 *     specifiers, and shipped as a `data:` URL in ONE import map — dynamic `import('og:…')` from
 *     the runtime resolves through the map, so islands hydrate exactly as on the server;
 *   • the runtime script is inlined as a module; modulepreload hints are dropped (nothing to fetch);
 *   • island `entry` attributes are rewritten to their `og:` keys.
 *
 * Pure: the caller supplies `load(url)` (a self-fetch in the profiler host, a map in tests). Dev
 * servers are refused upstream — their module graph is Vite's, not a bundle.
 */

export interface StandaloneOptions {
	/** the report page's own URL (relative hrefs resolve against it) */
	page_url: string;
	/** fetch a same-origin asset by absolute URL; `null` when it cannot be read */
	load: (url: string) => Promise<string | null>;
	/** refuse past this many bytes of inlined assets (a runaway graph) */
	max_bytes?: number;
}

const STYLESHEET_RE = /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi;
const MODULEPRELOAD_RE = /<link\b[^>]*\brel=["']modulepreload["'][^>]*>/gi;
const HREF_RE = /\bhref=["']([^"']+)["']/i;
const MODULE_SCRIPT_RE = /<script\b([^>]*\btype=["']module["'][^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi;
const ENTRY_ATTR_RE = /(<ogygia-region\b[^>]*\bentry=["'])([^"']+)(["'])/gi;
/** a static or dynamic import of a RELATIVE specifier inside a built chunk — quoted, or a
 *  template literal with no interpolation (Vite emits `import(\`./chunks/x.js\`)`) */
const IMPORT_RE = /((?:\bfrom|\bimport)\s*\(?\s*)(["'`])(\.{1,2}\/[^"'`$]+)\2/g;
/** any other relative chunk path in a string: Vite's `__vite__mapDeps` preload list. Pointed at
 *  the same keys so a preload link never resolves against the document (a `file://` fetch). */
const DEP_STRING_RE = /(["'])(\.{1,2}\/[^"'`\s]+\.(?:js|css))\1/g;

/** The import-map key for a chunk. An absolute URL with a `//` authority on purpose: the runtime's
 *  `island_module_url` hands an `entry` with a URL scheme through untouched (a bare `og:/x` would
 *  be resolved against the document and lose the scheme), and a `data:` module can import an
 *  absolute URL where it cannot import a relative one. */
const key_of = (u: URL) => `og://chunks${u.pathname}`;

export async function build_standalone(html: string, opts: StandaloneOptions): Promise<string> {
	const base = new URL(opts.page_url);
	const max = opts.max_bytes ?? 12 * 1024 * 1024;
	let bytes = 0;
	const chunks = new Map<string, string>(); // og:key → rewritten source
	const missing: string[] = [];

	const fetch_text = async (u: URL): Promise<string | null> => {
		const text = await opts.load(u.href);
		if (text === null) {
			missing.push(u.pathname);
			return null;
		}
		bytes += text.length;
		if (bytes > max) throw new Error(`standalone report would exceed ${Math.round(max / 1048576)} MB of inlined assets`);
		return text;
	};

	/** rewrite a chunk's relative imports to `og:` keys and pull those chunks in too */
	const add_chunk = async (u: URL): Promise<string> => {
		const key = key_of(u);
		const have = chunks.get(key);
		if (have !== undefined) return key;
		chunks.set(key, ''); // mark before recursing (cycles)
		const src = await fetch_text(u);
		if (src === null) return key;
		const deps: URL[] = [];
		const rewritten = src
			.replace(IMPORT_RE, (_, lead: string, q: string, spec: string) => {
				const dep = new URL(spec, u);
				deps.push(dep);
				return `${lead}${q}${key_of(dep)}${q}`;
			})
			.replace(DEP_STRING_RE, (_, q: string, spec: string) => {
				const dep = new URL(spec, u);
				if (spec.endsWith('.js')) deps.push(dep);
				return `${q}${key_of(dep)}${q}`;
			});
		chunks.set(key, rewritten);
		for (const dep of deps) await add_chunk(dep);
		return key;
	};

	// 1. stylesheets → <style>
	const sheets: { tag: string; url: URL }[] = [];
	for (const m of html.matchAll(STYLESHEET_RE)) {
		const href = HREF_RE.exec(m[0])?.[1];
		if (href) sheets.push({ tag: m[0], url: new URL(href, base) });
	}
	for (const s of sheets) {
		const css = await fetch_text(s.url);
		html = html.replace(s.tag, css === null ? '' : `<style data-standalone="${s.url.pathname}">${css.replaceAll('</style', '<\\/style')}</style>`);
	}
	// 2. modulepreload hints: nothing to preload from a file
	html = html.replace(MODULEPRELOAD_RE, '');
	// 3. module scripts with a src → inline modules (their imports go through the map)
	const scripts: { tag: string; attrs: string; url: URL }[] = [];
	for (const m of html.matchAll(MODULE_SCRIPT_RE)) {
		scripts.push({ tag: m[0], attrs: (m[1] + ' ' + m[3]).replace(/\s+/g, ' ').trim(), url: new URL(m[2], base) });
	}
	for (const s of scripts) {
		const key = await add_chunk(s.url);
		const code = chunks.get(key) ?? '';
		html = html.replace(
			s.tag,
			`<script type="module" ${s.attrs.replace(/\btype=["']module["']/i, '').trim()} data-standalone="${s.url.pathname}">${code.replaceAll('</script', '<\\/script')}</script>`
		);
		chunks.delete(key); // inlined, not in the map
	}
	// 4. island entries → og: keys (the runtime `import()`s the attribute)
	const entries: URL[] = [];
	html = html.replace(ENTRY_ATTR_RE, (_, open: string, href: string, close: string) => {
		const u = new URL(href, base);
		entries.push(u);
		return `${open}${key_of(u)}${close}`;
	});
	for (const u of entries) await add_chunk(u);

	// 5. the import map: every chunk as a data: URL, before the first module script
	const imports: Record<string, string> = {};
	for (const [key, code] of chunks) {
		if (!code) continue;
		imports[key] = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
	}
	const map = `<script type="importmap">${JSON.stringify({ imports }).replaceAll('</script', '<\\/script')}</script>`;
	const note = `<!-- ogygia profiler · standalone report · ${Object.keys(imports).length} chunks inlined${missing.length ? ` · missing: ${missing.join(', ')}` : ''} -->`;
	const at = html.search(/<script\b/i);
	html = at === -1 ? html.replace(/<\/head>/i, `${map}</head>`) : html.slice(0, at) + map + html.slice(at);
	return html.replace(/<\/head>/i, `<meta name="ogygia-standalone" content="1">${note}</head>`);
}
