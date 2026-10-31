// `@ogygia/content/types` — the content macros on `import.meta.og` (merged into core's `ImportMetaOg`
// from `ogygia/types`). Reference both from the app's `src/app.d.ts`:
//
//   /// <reference types="ogygia/types" />
//   /// <reference types="@ogygia/content/types" />
//
// They are compile constructs: the `content()` plugin rewrites each call at transform time.
interface ImportMetaOg {
	/**
	 * Content LOADERS — each call becomes a `Source` for `content({ loader })`. The macro owns
	 * the `import.meta.glob(…, { eager: false })` plumbing: pass a LITERAL glob (or, for `git`,
	 * a repo spec) and nothing else. Anything DYNAMIC (a CMS, a database) is a hand-written
	 * `Source` instead — these four cover the static/compile-time cases. Server-only.
	 */
	readonly loader: {
		/** A markdown/`.svx` collection from a LITERAL glob (e.g. `'./docs/**\/*.svx'`).
		 *  `meta.headings` comes for free. */
		markdown(
			glob: string,
			opts?: { id?: (key: string) => string } & { preset?: string }
		): import('@ogygia/content').Source<import('@ogygia/content').MarkdownMeta>;
		/** A filesystem-CONVENTION collection from a LITERAL glob (e.g.
		 *  `'../content/**\/{+doc.svx,+meta.json}'`) — `NN-` ordering, `+meta.json` labels. */
		folder<Meta = Record<string, never>>(
			glob: string,
			opts?: import('@ogygia/content').FolderOptions<Meta> & { preset?: string }
		): import('@ogygia/content').Source<Meta>;
		/** A JSON-data collection from a LITERAL glob (e.g. `'./authors/*.json'`). */
		json(
			glob: string,
			opts?: { id?: (key: string) => string } & { preset?: string }
		): import('@ogygia/content').Source;
		/**
		 * Source a collection straight from another git repository — no committed copy, no sync
		 * script. `spec` is a LITERAL `owner/repo[@ref][:path]`; `opts` forwards to `folder`.
		 * The plugin materializes a shallow checkout at build (cached in `node_modules/.ogygia`).
		 */
		git<Meta = Record<string, never>>(
			spec: string,
			opts?: import('@ogygia/content').FolderOptions<Meta> & { preset?: string }
		): import('@ogygia/content').Source<Meta>;
	};
	/**
	 * A block REGISTRY from a LITERAL glob (e.g. `'./blocks/*.svelte'`). At build the macro globs
	 * the pattern (relative to this module) and emits one `with { region: 'raw' }` import per
	 * match, returning a `{ <Basename>: Component }` map keyed by each file's basename (the CMS
	 * `type` name). Every block is a raw held region, so its own nested islands wake. A block that
	 * needs a wake schedule stays a manual import spread over the top. Server-only (drives SSR).
	 */
	regions(glob: string): import('@ogygia/content').BlockRegistry;
	/**
	 * A highlighted code SNIPPET, rendered at BUILD through the app's own Shiki fence pipeline and
	 * inlined as a static region (no client JS). `source` is a STATIC string or template literal
	 * (a `${…}` interpolation is a build error); `lang` is the language; `meta` is the raw fence
	 * infostring, so `'twoslash {2-4} file=app.ts'` behaves exactly as in a markdown fence. The
	 * macro dedents `source` and returns a region — render it with `<Region of={…} />`.
	 */
	code(source: string, lang: string, meta?: string): import('@ogygia/core').RegionValue;
	/**
	 * A Markdown STRING rendered at BUILD through the app's own markdown pipeline (same remark/rehype
	 * plugins, same Shiki fences) and inlined as a static region — so `md('…')` and a `.md` document
	 * render identically. `text` is a STATIC string or template literal (no `${…}` interpolation).
	 * For static prose + fenced code only (dynamic content is a build error); render with
	 * `<Region of={…} />`.
	 */
	md(text: string): import('@ogygia/core').RegionValue;
}
