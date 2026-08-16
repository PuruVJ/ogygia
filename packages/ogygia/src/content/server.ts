/**
 * Server-only remote layer for content collections. The ONLY module here that imports
 * `$app/server`, so it must be used from a `.remote.ts` (Kit guarantees those run on the server).
 *
 * `content()` (browser-safe) defines a collection once, importable anywhere. `withRemotes(collection)`
 * augments it with the Kit remotes that cross the wire (and keeps its read methods):
 *
 * ```ts
 * // collections.ts — the ONE definition, browser-safe
 * export const docs = content({ from, format, schema, relations });
 *
 * // docs.remote.ts — server-only
 * import { withRemotes } from 'ogygia/content/server';
 * const r = withRemotes(docs);
 * export const docNav  = r.list({ map: (e) => ({ id: e.id, title: e.data.title }) });
 * export const feed    = r.live.list({ map });
 * export const oneLive = r.live.get({ map, notFound: null });
 * ```
 */
import { prerender, query } from '$app/server';
import type { ContentRef, Entry } from './index.js';
import { Collection, COLLECTION } from './collection-base.js';

export type ContentMode = 'prerender' | 'query';

/** Return types for the minted remotes (the callable shape consumers use; cast for extra methods). */
export type ListRemote<Out> = () => Promise<Out[]>;
export type GetRemote<Out> = (id: string) => Promise<Out>;

type RefsOptions<T extends Record<string, unknown>, Out> = {
	/** `'prerender'` (default for static globs) or `'query'` (default for async/streaming sources). */
	mode?: ContentMode;
	/** Kit prerender `dynamic` — default `true` when mode is prerender. */
	dynamic?: boolean;
	filter?: (entry: ContentRef<T>) => boolean;
	map?: (entry: ContentRef<T>) => Out;
};
type LiveRefsOptions<T extends Record<string, unknown>, Out> = {
	filter?: (entry: ContentRef<T>) => boolean;
	map?: (entry: ContentRef<T>) => Out;
};
type LiveGetOptions<T extends Record<string, unknown>, Out> = {
	filter?: (entry: ContentRef<T>) => boolean;
	map?: (entry: ContentRef<T>) => Out;
	/** Yielded when missing / filtered out. Default `null`. */
	notFound?: Out | null;
};

/** The server-side handle `withRemotes()` returns: the collection's read paths + its remotes. */
export interface WithRemotes<T extends Record<string, unknown>> {
	refs(): Promise<ContentRef<T>[]>;
	get(id: string): Promise<Entry<T> | null>;
	/** Prerendered/query remote over the corpus refs (wire-safe metadata). */
	list<Out = { id: string; data: T }>(options?: RefsOptions<T, Out>): ListRemote<Out>;
	live: {
		list<Out = { id: string; data: T }>(options?: LiveRefsOptions<T, Out>): ListRemote<Out>;
		get<Out = { id: string; data: T } | null>(options?: LiveGetOptions<T, Out>): GetRemote<Out>;
	};
}

/** Minimal Standard Schema string — avoids a valibot dependency in the library. */
const string_arg = {
	['~standard']: {
		version: 1 as const,
		vendor: 'ogygia-content',
		validate(value: unknown) {
			if (typeof value === 'string') return { value };
			return { issues: [{ message: 'Expected string' }] };
		}
	}
};

/** Reach the underlying `Collection` behind a `content()` / `collection()` handle. */
function collection_of<T extends Record<string, unknown>>(handle: unknown): Collection<T> {
	const c = (handle as Record<symbol, unknown>)?.[COLLECTION];
	if (!(c instanceof Collection)) {
		throw new Error(
			'[ogygia/content] withRemotes() expects a collection from content()/collection()'
		);
	}
	return c as Collection<T>;
}

/**
 * Augment a browser-safe collection with its Kit remotes (and keep its read methods). Server-only
 * (imports `$app/server`) — call it from a `.remote.ts`.
 */
export function withRemotes<T extends Record<string, unknown> = Record<string, unknown>>(
	handle: unknown
): WithRemotes<T> {
	const c = collection_of<T>(handle);
	const default_mode: ContentMode = c.streaming
		? 'query'
		: c.fromIsFunction
			? 'query'
			: 'prerender';

	return {
		refs: () => c.refs(),
		get: (id: string) => c.get(id),

		list<Out = { id: string; data: T }>(options: RefsOptions<T, Out> = {}): ListRemote<Out> {
			const mode = options.mode ?? default_mode;
			const filter = c.compose(options.filter);
			const map = options.map ?? ((e: ContentRef<T>) => ({ id: e.id, data: e.data }) as Out);

			const run = async () => {
				const all = await c.ready();
				const rows = await Promise.all(all.filter(filter).map((e) => c.withGraph(e)));
				return Promise.all(rows.map(map));
			};

			if (mode === 'query') return query(run) as unknown as ListRemote<Out>;
			if (c.streaming) {
				throw new Error(
					'[ogygia/content] streaming `loader` cannot use prerender list — use live.list() or mode: "query"'
				);
			}
			return prerender(run, { dynamic: options.dynamic ?? true }) as unknown as ListRemote<Out>;
		},

		live: {
			list<Out = { id: string; data: T }>(options: LiveRefsOptions<T, Out> = {}): ListRemote<Out> {
				const filter = c.compose(options.filter);
				const map = options.map ?? ((e: ContentRef<T>) => ({ id: e.id, data: e.data }) as Out);
				const project = async (rows: ContentRef<T>[]) =>
					Promise.all((await Promise.all(rows.filter(filter).map((e) => c.withGraph(e)))).map(map));

				return query.live(async function* () {
					yield await project(await c.ready());
					for await (const _ of c.watchChanges()) yield await project(c.snapshot());
				}) as unknown as ListRemote<Out>;
			},

			get<Out = { id: string; data: T } | null>(options: LiveGetOptions<T, Out> = {}): GetRemote<Out> {
				const filter = c.compose(options.filter);
				const notFound = ('notFound' in options ? options.notFound : null) as Out;
				const map = options.map ?? ((e: ContentRef<T>) => ({ id: e.id, data: e.data }) as Out);
				const project = async (id: string): Promise<Out> => {
					const e = c.lookup(id);
					if (!e || !filter(e)) return notFound;
					return map(await c.withGraph(e));
				};

				return query.live(string_arg, async function* (id: string) {
					await c.ready();
					yield await project(id);
					for await (const _ of c.watchChanges()) yield await project(id);
				}) as unknown as GetRemote<Out>;
			}
		}
	};
}

// ── the site kit's server half ── `remotes(site)` minting (Kit query()/prerender wiring).
export * from './site/server.js';
