/**
 * `content()` — the ONE way to define a content collection. **Browser-safe** (no `$app/server`), so
 * one definition is importable anywhere: routes, `+page`, islands, `.remote.ts`.
 *
 * Fully inferred — no type annotations. `Data` comes from `schema` (a Standard Schema's output),
 * `Meta` from the source. A self relation uses the `(self) => …` callback so there is no type cycle:
 *
 * ```ts
 * import { content, mdsvex } from 'ogygia/content';
 * export const docs = content({
 *   loader: mdsvex(import.meta.glob('./docs/**\/*.svx')), // Meta = { headings }
 *   schema: docSchema,                                    // Data  = InferOutput<docSchema>
 *   relations: (self) => ({ related: self, author: people })
 * });
 *
 * const entry = (await docs.get(slug)) ?? error(404);     // { data, meta, body, rel, backlinks }
 * ```
 *
 * To mint the Kit remotes that cross the wire (`list` / `live.*`), wrap it with `withRemotes()` from
 * `ogygia/content/server` inside a `.remote.ts`.
 */
import type { ContentEntry, ContentRelations, Entry, SchemaLike } from './index.js';
import type { Source } from './source.js';
import { Collection, COLLECTION, type CollectionBaseOptions } from './collection-base.js';

/** Extract a Standard Schema's output type (valibot / zod / arktype). Falls back to a loose record. */
type SchemaData<S> = S extends { readonly ['~standard']: { readonly types?: { readonly output: infer O } } }
	? O extends Record<string, unknown>
		? O
		: Record<string, unknown>
	: Record<string, unknown>;

/** Options for a content collection (kept for reference; `content()` infers these in place). */
export type ContentOptions<
	Data extends Record<string, unknown> = Record<string, unknown>,
	Meta = Record<string, never>
> = {
	loader: Source<Meta>;
	schema?: SchemaLike;
	filter?: (entry: ContentEntry<Data, Meta>) => boolean;
	relations?: (self: ContentHandle<Data, Meta>) => ContentRelations;
};

/** The browser-safe handle `content()` returns (read paths + graph; remotes come from `withRemotes()`). */
export interface ContentHandle<
	Data extends Record<string, unknown> = Record<string, unknown>,
	Meta = Record<string, never>
> {
	/** All visible entries (each with `rel` / `backlinks`). */
	entries(): Promise<ContentEntry<Data, Meta>[]>;
	/** One visible entry by id (with `rel` / `backlinks`), or `null`. */
	entry(id: string): Promise<ContentEntry<Data, Meta> | null>;
	ids(): Promise<string[]>;
	/**
	 * Resolve one entry to `{ id, data, meta, body, rel, backlinks }` for rendering. `body` is an
	 * inline `<Region>`. Unknown / filtered-out id → `null` (the caller decides the 404).
	 */
	get(id: string): Promise<Entry<Data, Meta> | null>;
}

export function content<
	Meta = Record<string, never>,
	Schema extends SchemaLike | undefined = undefined,
	Data extends Record<string, unknown> = Schema extends SchemaLike
		? SchemaData<Schema>
		: Record<string, unknown>
>(opts: {
	/** Where entries come from — a source (`mdsvex(...)`, `json(...)`, `blocks(...)`, `glob(...)`, …). */
	loader: Source<Meta>;
	/** Standard Schema (valibot / zod / arktype) validating each entry's `data`; `Data` is its output. */
	schema?: Schema;
	/** Collection-level visibility filter, honored by every read path. */
	filter?: (entry: ContentEntry<Data, Meta>) => boolean;
	/** Relations to other collections — an object, or `(self) => object` for self / mutual relations. */
	relations?: (self: ContentHandle<Data, Meta>) => ContentRelations;
}): ContentHandle<Data, Meta> {
	const c = new Collection<Data, Meta>(opts as unknown as CollectionBaseOptions<Data, Meta>);
	const handle: ContentHandle<Data, Meta> = {
		entries: () => c.entries(),
		entry: (id) => c.entry(id),
		ids: () => c.ids(),
		get: (id) => c.get(id)
	};
	// Link the handle to its Collection (relations resolve to the instance; `withRemotes()` reaches it),
	// then hand the collection its own handle so a `relations: (self) => …` callback can resolve.
	Object.defineProperty(handle, COLLECTION, { value: c, enumerable: false });
	c.bindSelf(handle);
	return handle;
}
