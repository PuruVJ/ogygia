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
import type { ContentRef, ContentRelations, Entry, SchemaLike } from './index.js';
import type { GroupMeta, Source } from './source.js';
import { Collection, COLLECTION, type CollectionBaseOptions, type ReadContext } from './collection-base.js';

/** Extract a Standard Schema's output type (valibot / zod / arktype). Falls back to a loose record. */
type SchemaData<S> = S extends { readonly ['~standard']: { readonly types?: { readonly output: infer O } } }
	? O extends Record<string, unknown>
		? O
		: Record<string, unknown>
	: Record<string, unknown>;

/** Schema input: one Standard Schema, or an ARRAY layered left→right (a genre stack + user extras). */
export type SchemaInput = SchemaLike | SchemaLike[];

/** Merge the output type of a schema OR a tuple of schemas (each layer's fields union). */
type LayeredData<S> = S extends readonly unknown[]
	? UnionToIntersection<{ [K in keyof S]: SchemaData<S[K]> }[number]>
	: SchemaData<S>;
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Options for a content collection (kept for reference; `content()` infers these in place). */
export type ContentOptions<
	Data extends Record<string, unknown> = Record<string, unknown>,
	Meta = Record<string, never>
> = {
	loader: Source<Meta>;
	schema?: SchemaInput;
	filter?: (entry: ContentRef<Data, Meta>, ctx: ReadContext) => boolean;
	relations?: (self: ContentHandle<Data, Meta>) => ContentRelations;
};

/** The browser-safe handle `content()` returns (read paths + graph; remotes come from `withRemotes()`). */
export interface ContentHandle<
	Data extends Record<string, unknown> = Record<string, unknown>,
	Meta = Record<string, never>
> {
	/** The corpus as metadata — all visible REFS (each with `rel` / `backlinks`), never bodies. `ctx`
	 *  threads into the collection `filter` (preview, roles); default `{}` = the public projection. */
	refs(ctx?: ReadContext): Promise<ContentRef<Data, Meta>[]>;
	/**
	 * Resolve one entry to `{ id, data, meta, body, source, rel, backlinks }` for rendering. `body` is
	 * an inline `<Region>`. Unknown / filtered-out id → `null` (the caller decides the 404).
	 */
	get(id: string, ctx?: ReadContext): Promise<Entry<Data, Meta> | null>;
	/** Directory/section decoration the source exposes (`folder()` from `+meta.json`, a CMS from folders). */
	groups(): Promise<Map<string, GroupMeta>>;
}

export function content<
	Meta = Record<string, never>,
	Schema extends SchemaInput | undefined = undefined,
	Data extends Record<string, unknown> = Schema extends SchemaInput
		? LayeredData<Schema> extends Record<string, unknown>
			? LayeredData<Schema>
			: Record<string, unknown>
		: Record<string, unknown>
>(opts: {
	/** Where entries come from — a source (`markdown(...)`, `json(...)`, `blocks(...)`, `folder(...)`, …). */
	loader: Source<Meta>;
	/** Standard Schema (or an array, layered) validating each entry's `data`; `Data` is its merged output. */
	schema?: Schema;
	/** Collection-level visibility filter, honored by every read path. `ctx` is the request context. */
	filter?: (entry: ContentRef<Data, Meta>, ctx: ReadContext) => boolean;
	/** Relations to other collections — an object, or `(self) => object` for self / mutual relations. */
	relations?: (self: ContentHandle<Data, Meta>) => ContentRelations;
}): ContentHandle<Data, Meta> {
	const c = new Collection<Data, Meta>(opts as unknown as CollectionBaseOptions<Data, Meta>);
	const handle: ContentHandle<Data, Meta> = {
		refs: (ctx) => c.refs(ctx),
		get: (id, ctx) => c.get(id, ctx),
		groups: () => c.groups()
	};
	// Link the handle to its Collection (relations resolve to the instance; `withRemotes()` reaches it),
	// then hand the collection its own handle so a `relations: (self) => …` callback can resolve.
	Object.defineProperty(handle, COLLECTION, { value: c, enumerable: false });
	c.bindSelf(handle);
	return handle;
}
