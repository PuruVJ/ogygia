/**
 * The content **source** — the single axis `content({ from })` accepts. A source yields entries by
 * `get(id)` / `list(query)` / `ids()`, so params drive the fetch instead of filtering a materialized
 * pile. Every built-in format (`mdsvex`, `json`, `yaml`, `blocks`, …) is just a *source builder*: it
 * wraps a raw record source (a glob, or your API) with a parse step and returns one of these.
 *
 * Two typed axes flow through:
 *  - `data`  — authored, validated by the collection's `schema`.
 *  - `meta`  — derived by the format (headings, reading time), typed by the source.
 *
 * `init()` (optional, async) runs once before the first read. Source builders use it to
 * dynamic-import their heavy machinery (the `yaml` parser, the `Blocks` renderer component), so the
 * module graph stays light and every builder is importable from `ogygia/content` — no eager deps,
 * no `.svelte` pulled at module-eval.
 */
import type { RegionValue } from '../region.js';

/** What a format computes from one raw record. `body` is already a region you render with `<Region>`. */
export type EntryParts<Meta = Record<string, never>> = {
	data: Record<string, unknown>;
	body?: RegionValue;
	meta?: Meta;
};

/** An entry a source yields — parts plus identity. `data` is still raw; the collection's schema validates it. */
export type SourceEntry<Meta = Record<string, never>> = EntryParts<Meta> & {
	id: string;
	/** Glob key / file path, when the source has one (powers FS-derived nav). */
	filePath?: string;
};

/**
 * A live source's change signal. Yield to tell the collection to re-read:
 *  - yield **anything** (e.g. `1`) → the collection re-lists the whole source (simple, default);
 *  - yield a **`string[]` of ids** → the collection reloads only those ids (`get(id)` each, missing
 *    ids are dropped) — incremental, for large collections where a full re-list is wasteful.
 */
export type SourceChanges = AsyncIterable<string[] | unknown>;

/** The source contract — the only thing `content({ from })` accepts. */
export type Source<Meta = Record<string, never>> = {
	/** Run once before the first read. Dynamic-import heavy deps here. */
	init?: () => Promise<void>;
	get(id: string): Promise<SourceEntry<Meta> | null>;
	list(query?: unknown): Promise<SourceEntry<Meta>[]>;
	ids(): Promise<string[]>;
	/** Optional reactive signal — present on live sources (a CMS feed, a stream). */
	live?: () => SourceChanges;
};

/** One raw record before parsing: a compiled `.svx` module, a JSON blob, an API result. */
export type RawRecord<V> = { id: string; value: V; filePath?: string };

/** A raw source yields unparsed values; a {@link Format} turns each into {@link EntryParts}. */
export type RawSource<V> = {
	init?: () => Promise<void>;
	get(id: string): Promise<RawRecord<V> | null>;
	list(query?: unknown): Promise<RawRecord<V>[]>;
	ids(): Promise<string[]>;
	live?: () => SourceChanges;
};

/** Parse one raw value into entry parts (data + optional body + optional meta). */
export type Format<V, Meta = Record<string, never>> = (
	value: V,
	id: string
) => EntryParts<Meta> | Promise<EntryParts<Meta>>;

/** `import.meta.glob(...)` map — eager values or lazy loaders. */
export type GlobMap = Record<string, unknown | (() => Promise<unknown>)>;

const BACKSLASH = /\\/g;
const filePathOf = (key: string) => key.replace(BACKSLASH, '/').split('?')[0];

/** Strip ONE trailing extension, whatever it is — no hardcoded format list. */
const stripExt = (p: string) => p.replace(/\.[^./\\]+$/, '');

/**
 * Default id for a glob: drop the directory prefix shared by all keys, then the file extension.
 * `../content/docs/00-start/install.svx` (in a set rooted at `.../docs/`) → `00-start/install`.
 * Override entirely with `glob(map, { id })` when you want different ids (e.g. strip `NN-` prefixes).
 */
function defaultGlobIds(keys: string[]): Map<string, string> {
	const norm = keys.map((k) => k.replace(BACKSLASH, '/').split('?')[0]);
	let prefix = norm[0] ? norm[0].slice(0, norm[0].lastIndexOf('/') + 1) : '';
	for (const p of norm.slice(1)) {
		while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
	}
	const out = new Map<string, string>();
	keys.forEach((key, i) => {
		const rel = stripExt(norm[i].slice(prefix.length));
		out.set(key, rel || stripExt(norm[i]));
	});
	return out;
}

/** True for a value that already implements the raw-source contract (get/list/ids functions). */
function isRawSource<V>(v: unknown): v is RawSource<V> {
	return (
		!!v &&
		typeof (v as RawSource<V>).get === 'function' &&
		typeof (v as RawSource<V>).list === 'function' &&
		typeof (v as RawSource<V>).ids === 'function'
	);
}

/**
 * Wrap an `import.meta.glob(...)` map as a raw source: `ids` are the (prefix-stripped, extension-less)
 * keys, `get(id)` loads ONE module, `list()` loads all. Lazy globs load a module only when read — so
 * `get(id)` on a big local collection touches one file, not the whole set.
 */
export function glob<V = unknown>(
	globMap: GlobMap,
	opts: { id?: (key: string) => string } = {}
): RawSource<V> {
	const keys = Object.keys(globMap).sort();
	const defaults = opts.id ? null : defaultGlobIds(keys);
	const idFor = (key: string) => (opts.id ? opts.id(key) : (defaults!.get(key) ?? key));
	const byId = new Map<string, string>();
	for (const key of keys) {
		const id = idFor(key);
		if (!id || id.includes('..') || id.startsWith('/')) {
			throw new Error(`[ogygia/content] illegal id '${id}' for ${key}`);
		}
		if (byId.has(id)) throw new Error(`[ogygia/content] duplicate id '${id}' (${key})`);
		byId.set(id, key);
	}
	const load = async (key: string): Promise<V> => {
		const v = globMap[key];
		return (typeof v === 'function' ? await (v as () => Promise<V>)() : v) as V;
	};
	const record = async (id: string, key: string): Promise<RawRecord<V>> => ({
		id,
		value: await load(key),
		filePath: filePathOf(key)
	});
	return {
		async get(id) {
			const key = byId.get(id);
			return key ? record(id, key) : null;
		},
		list: () => Promise.all([...byId].map(([id, key]) => record(id, key))),
		ids: async () => [...byId.keys()]
	};
}

/** Compose a raw source + a format into a finished {@link Source}. Threads `init` and `live` through. */
export function defineSource<V, Meta = Record<string, never>>(
	raw: RawSource<V>,
	format: Format<V, Meta>,
	extra?: { init?: () => Promise<void> }
): Source<Meta> {
	const parse = async (r: RawRecord<V>): Promise<SourceEntry<Meta>> => {
		const parts = await format(r.value, r.id);
		return { id: r.id, ...(r.filePath ? { filePath: r.filePath } : {}), ...parts };
	};
	const inits = [raw.init, extra?.init].filter(Boolean) as Array<() => Promise<void>>;
	return {
		...(inits.length ? { init: async () => void (await Promise.all(inits.map((f) => f()))) } : {}),
		async get(id) {
			const r = await raw.get(id);
			return r ? parse(r) : null;
		},
		list: async (q) => Promise.all((await raw.list(q)).map(parse)),
		ids: () => raw.ids(),
		...(raw.live ? { live: raw.live } : {})
	};
}

/** Turn a source builder's input (a glob map, or a raw source you wrote) into a raw source. */
export function toRawSource<V>(
	input: GlobMap | RawSource<V>,
	opts: { id?: (key: string) => string } = {}
): RawSource<V> {
	return isRawSource<V>(input) ? input : glob<V>(input, opts);
}

/**
 * Transform every raw record's value through `fn` — raw-source middleware for building custom loaders
 * (e.g. a CMS adapter that maps its JSON shape to what `blocks()`/`mdsvex()` expect). Threads
 * `init`/`live` through unchanged.
 */
export function mapRaw<A, B>(src: RawSource<A>, fn: (value: A) => B): RawSource<B> {
	return {
		...(src.init ? { init: src.init } : {}),
		...(src.live ? { live: src.live } : {}),
		async get(id) {
			const r = await src.get(id);
			return r ? { ...r, value: fn(r.value) } : null;
		},
		async list(q) {
			return (await src.list(q)).map((r) => ({ ...r, value: fn(r.value) }));
		},
		ids: () => src.ids()
	};
}

// NB: no `fromArray` / in-memory-array source is shipped — write a `{ get, list, ids }` object
// directly (or use `defineSource`) for fixtures or already-fetched records.
