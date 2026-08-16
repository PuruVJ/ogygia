/**
 * RF-native content collections for SvelteKit.
 *
 * Define once with `content({ loader, schema, relations })` — browser-safe, import anywhere. `loader`
 * is a **source** (`{ get, list, ids }`); the built-in formats are source builders that produce one:
 *
 *   import { content, markdown } from 'ogygia/content';
 *   export const docs = content({ loader: markdown(import.meta.glob('./docs/**\/*.svx')), schema });
 *
 * Read paths — `get` / `entry` / `ids` / `entries` + the content graph — live here. To mint the Kit
 * remotes that cross the wire, wrap it with `withRemotes()` from `ogygia/content/server` in a
 * `.remote.ts`.
 */
import type { RegionValue } from '../region.js';

/** A heading pulled from the markdown pass (h2–h4). Powers on-page TOCs; rides `markdown` `meta`. */
export type Heading = { depth: 2 | 3 | 4; id: string; text: string };

/** One markdown link collected during the compile pass (raw, unclassified). Rides `markdown` `meta`;
 *  ogygia's audit resolves these against the site's address space. `line` is approximate (relative
 *  to the post-frontmatter text). */
export type LinkRef = { href: string; text: string; line?: number };

/**
 * A resolved relation target: a shallow reference to another entry — its `id` and validated `data`.
 * Deliberately shallow (no body, no URL); build the link from `ref.id`, or `collection.get(ref.id)`.
 */
export type RefEntry<Data = Record<string, unknown>> = {
	id: string;
	data: Data;
};

/**
 * Declared relations: `{ name: collection }`, or `{ get name() { return collection } }` for a cycle.
 * The frontmatter field named after each relation carries the target id(s): a string → one ref, a
 * string[] → many.
 */
export type ContentRelations = Record<string, unknown>;

/**
 * A content REF — the shallow face of an entry, what `refs()` yields and the catalog holds: identity
 * + validated `data` (+ source-derived `meta`, structural `order`, `filePath`, and graph fields). NO
 * body, NO source text — those are heavy faces that live only on {@link Entry}, fetched by `get()`.
 * "Refs are what a corpus admits to having; an entry is what one page pays for."
 */
export type ContentRef<Data = Record<string, unknown>, Meta = Record<string, never>> = {
	id: string;
	/** Validated frontmatter. */
	data: Data;
	/** Source-derived facts (headings, reading time, …). `{}` for a source that derives none. */
	meta: Meta;
	/** Per-level sibling order, when the source supplies it (`folder()` from `NN-`, a CMS from a field). */
	order?: number[];
	/** Glob key / file path when the source has one. */
	filePath?: string;
	/** Resolved relations (populated by the graph pass on read paths that resolve them). */
	rel?: Record<string, RefEntry | RefEntry[] | null>;
	/** Entries pointing at this one (populated by the graph pass). */
	backlinks?: RefEntry[];
};

/** @deprecated Old name for {@link ContentRef}. A ref never carries a body; use `Entry` (from `get()`) for that. */
export type ContentEntry<Data = Record<string, unknown>, Meta = Record<string, never>> = ContentRef<Data, Meta>;

/**
 * A resolved entry from `get()` — `data`, `meta`, `body`, and the graph fields fully populated. `rel`
 * is `{}` and `backlinks` `[]` when the collection has no graph. `body` is an inline `<Region>`,
 * rendered in the page's own SSR pass, so islands inside it hydrate normally.
 */
export type Entry<Data = Record<string, unknown>, Meta = Record<string, never>> = {
	id: string;
	data: Data;
	meta: Meta;
	body?: RegionValue;
	/** Lazy raw SOURCE text, when the source provides it (`markdown()` does). Server-only; never wired. */
	source?: () => Promise<string>;
	rel: Record<string, RefEntry | RefEntry[] | null>;
	backlinks: RefEntry[];
};

/** One Standard Schema validate result. `issues` is `ReadonlyArray` (matches valibot/zod/arktype). */
type StandardResult =
	| { value: unknown; issues?: undefined }
	| { issues: ReadonlyArray<{ readonly message?: string }> };

/** Any Standard Schema (valibot / zod / arktype) or a `{ parse }` object. */
export type SchemaLike = {
	['~standard']?: {
		validate: (value: unknown) => StandardResult | Promise<StandardResult>;
	};
	parse?: (value: unknown) => unknown;
};

// ── the source axis ──
export { glob, defineSource, toRawSource, mapRaw, enrich } from './source.js';
export type {
	Source,
	SourceRef,
	SourceEntry,
	EntryParts,
	RawSource,
	RawRecord,
	Format,
	GlobMap,
	GroupMeta,
	SourceChanges
} from './source.js';

// ── format source-builders (all live on `ogygia/content`) ──
export { markdown, json } from './formats.js';
export type { MarkdownMeta } from './formats.js';
// `folder()` — the filesystem-convention preset (one glob of `{+doc.svx,+meta.json}` → a full source).
export { folder } from './folder.js';
export type { FolderOptions } from './folder.js';

// The filename convention it runs on (moved here from ogygia — ordering is generic corpus knowledge).
export {
	numbered,
	dated,
	date_of as dateOf,
	title_case as titleCase,
	strip_order_prefix as stripOrderPrefix,
	order_of as orderOf
} from './convention.js';
export type { Convention, NumberedOptions, MetaDecoration } from './convention.js';
// `blocks()` is the content source; `blocks.resolve(tree, registry)` is the no-collection recipe
// helper (`type → region`, server-side). Both live on the one `blocks` export.
export { blocks } from './blocks.js';
export type { BlockNode, BlockRegistry, BlockSource, ResolvedBlockNode, BlockSchedule } from './blocks.js';

// ── the collection ──
export { content } from './factory.js';
export type { ContentHandle, ContentOptions } from './factory.js';

export { parseSchema } from './schema.js';

// Remote types live in the server-only `ogygia/content/server` module; re-export TYPES here
// (type-only, fully erased — never pulls `$app/server` into a browser graph).
export type { ContentMode, GetRemote, ListRemote, WithRemotes } from './server.js';

// The `import.meta.og.*` ambient types (loader.*, wire, …) live in the package-root
// `ambient.d.ts`, surfaced to apps via the `ogygia/types` reference every scaffold carries — ONE
// home, always on, no import required. The constructs themselves are rewritten by the vite plugin.

// ── the site layer ── outline → defineSite → shell components. One barrel: data layer + site brains
// + chrome all surface from `ogygia/content` (bundlers tree-shake what a given app doesn't touch).
export * from './site/index.js';
