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
 * A content entry. `data` is the validated frontmatter (typed by `schema`); `meta` is what the
 * source derives (typed by the source — e.g. `markdown` provides `{ headings }`); `body` is a
 * `<Region>` you render.
 */
export type ContentEntry<Data = Record<string, unknown>, Meta = Record<string, never>> = {
	id: string;
	/** Validated frontmatter. */
	data: Data;
	/** Source-derived facts (headings, reading time, …). `{}` for a source that derives none. */
	meta: Meta;
	/** The rendered body — `<Region of={entry.body} />`. Absent for data-only sources. */
	body?: RegionValue;
	/** Glob key / file path when the source has one. */
	filePath?: string;
	/** Resolved relations (populated by the graph pass on read paths that resolve them). */
	rel?: Record<string, RefEntry | RefEntry[] | null>;
	/** Entries pointing at this one (populated by the graph pass). */
	backlinks?: RefEntry[];
};

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
export { glob, defineSource, toRawSource, mapRaw } from './source.js';
export type {
	Source,
	SourceEntry,
	EntryParts,
	RawSource,
	RawRecord,
	Format,
	GlobMap,
	SourceChanges
} from './source.js';

// ── format source-builders (all live on `ogygia/content`) ──
export { markdown, json } from './formats.js';
export type { MarkdownMeta } from './formats.js';
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
