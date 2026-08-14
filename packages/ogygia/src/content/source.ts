/**
 * The content **source** — the single axis `content({ loader })` accepts. A source yields two shapes:
 *  - `refs(query?)` — the corpus as METADATA. A ref is identity + data (+ optional derived meta,
 *    sibling order, file path). NEVER a body, never source text — refs are wire-safe data, always.
 *  - `get(id)` — ONE full entry: a ref plus the two heavy faces (`body`, lazy `source`). The only
 *    read that pays to materialize a renderable.
 *
 * That split is the contract's spine: nav/weave/search-display/graph all consume refs; a page body is
 * fetched exactly once, by `get`, on the read that renders it. A filesystem glob makes both cheap; a
 * CMS maps `refs` to its shallow index endpoint and `get` to its document endpoint.
 *
 * Two more optional facets carry structure a backend knows and the weave can't derive:
 *  - `order` (per ref) — sibling order as data (folder() fills it from `NN-`; a CMS from a position field).
 *  - `groups()` — directory/section decoration as a map (folder() from `+meta.json`; a CMS from folders).
 *
 * `init()` (optional, async) runs once before the first read — source builders dynamic-import their
 * heavy machinery there so the module graph stays light and every builder is importable from
 * `ogygia/content`.
 */
import type { RegionValue } from '../region.js';

/** Directory/section decoration a source may expose (`groups()`), keyed by clean group path. */
export type GroupMeta = { label?: string };

/** What a format computes from one raw record. `body` is already a region you render with `<Region>`. */
export type EntryParts<Meta = Record<string, never>> = {
	data: Record<string, unknown>;
	body?: RegionValue;
	meta?: Meta;
	/**
	 * Lazy accessor for the entry's raw SOURCE text (the pre-compile `.svx` / `.json` / CMS payload).
	 * Optional and format-specific: `markdown()` fills it from the compiler; a CMS source returns its
	 * own `() => fetchRaw(id)`. Lazy on purpose — the bytes never ship to the client unless called.
	 */
	source?: () => Promise<string>;
};

/**
 * A shallow reference a source yields from `refs()` — identity + data, plus optional derived meta and
 * structural order. NEVER a body or source text; those live only on {@link SourceEntry}. Wire-safe.
 */
export type SourceRef<Meta = Record<string, never>> = {
	id: string;
	data: Record<string, unknown>;
	/** Format-derived facts (headings, reading time), when the source computes them cheaply for a ref. */
	meta?: Meta;
	/** Per-level sibling order (folder() from `NN-`, a CMS from a position field). Absent = unordered. */
	order?: number[];
	/** Glob key / file path, when the source has one (powers FS-derived nav). */
	filePath?: string;
};

/** One full entry a source yields from `get()` — a ref plus the two heavy faces. Never crosses a wire. */
export type SourceEntry<Meta = Record<string, never>> = SourceRef<Meta> & {
	body?: RegionValue;
	source?: () => Promise<string>;
};

/**
 * A live source's change signal. Yield to tell the collection to re-read:
 *  - yield **anything** (e.g. `1`) → the collection re-lists the whole source (simple, default);
 *  - yield a **`string[]` of ids** → the collection reloads only those ids (`get(id)` each, missing
 *    ids are dropped) — incremental, for large collections where a full re-list is wasteful.
 */
export type SourceChanges = AsyncIterable<string[] | unknown>;

/** The source contract — the only thing `content({ loader })` accepts. */
export type Source<Meta = Record<string, never>> = {
	/** Run once before the first read. Dynamic-import heavy deps here. */
	init?: () => Promise<void>;
	/** The corpus as metadata — refs, never bodies. */
	refs(query?: unknown): Promise<SourceRef<Meta>[]>;
	/** One full entry (ref + body + source), or `null`. */
	get(id: string): Promise<SourceEntry<Meta> | null>;
	/** Optional reactive signal — present on live sources (a CMS feed, a stream). */
	live?: () => SourceChanges;
	/** Optional directory/section decoration, keyed by clean group path. */
	groups?: () => Promise<Map<string, GroupMeta>>;
};

/** One raw record before parsing: a compiled `.svx` module, a JSON blob, an API result. */
export type RawRecord<V> = { id: string; value: V; order?: number[]; filePath?: string };

/** A raw source yields unparsed values; a {@link Format} turns each into {@link EntryParts}. */
export type RawSource<V> = {
	init?: () => Promise<void>;
	refs(query?: unknown): Promise<RawRecord<V>[]>;
	get(id: string): Promise<RawRecord<V> | null>;
	live?: () => SourceChanges;
	groups?: () => Promise<Map<string, GroupMeta>>;
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

/** True for a value that already implements the raw-source contract (refs/get functions). */
function isRawSource<V>(v: unknown): v is RawSource<V> {
	return (
		!!v &&
		typeof (v as RawSource<V>).refs === 'function' &&
		typeof (v as RawSource<V>).get === 'function'
	);
}

/**
 * Wrap an `import.meta.glob(...)` map as a raw source: ids are the (prefix-stripped, extension-less)
 * keys, `get(id)` loads ONE module, `refs()` loads all. Lazy globs load a module only when read — so
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
		refs: () => Promise.all([...byId].map(([id, key]) => record(id, key)))
	};
}

/** Compose a raw source + a format into a finished {@link Source}. Threads `init`/`live`/`groups`. */
export function defineSource<V, Meta = Record<string, never>>(
	raw: RawSource<V>,
	format: Format<V, Meta>,
	extra?: { init?: () => Promise<void>; groups?: () => Promise<Map<string, GroupMeta>> }
): Source<Meta> {
	// A ref drops body/source: we still run the format for `data`/`meta`, but the two heavy faces
	// never leave this function on the refs path.
	const ref = async (r: RawRecord<V>): Promise<SourceRef<Meta>> => {
		const parts = await format(r.value, r.id);
		return {
			id: r.id,
			data: parts.data,
			...(parts.meta !== undefined ? { meta: parts.meta } : {}),
			...(r.order !== undefined ? { order: r.order } : {}),
			...(r.filePath ? { filePath: r.filePath } : {})
		};
	};
	const full = async (r: RawRecord<V>): Promise<SourceEntry<Meta>> => {
		const parts = await format(r.value, r.id);
		return {
			id: r.id,
			data: parts.data,
			...(parts.meta !== undefined ? { meta: parts.meta } : {}),
			...(r.order !== undefined ? { order: r.order } : {}),
			...(r.filePath ? { filePath: r.filePath } : {}),
			...(parts.body !== undefined ? { body: parts.body } : {}),
			...(parts.source !== undefined ? { source: parts.source } : {})
		};
	};
	const inits = [raw.init, extra?.init].filter(Boolean) as Array<() => Promise<void>>;
	const groups = extra?.groups ?? raw.groups;
	return {
		...(inits.length ? { init: async () => void (await Promise.all(inits.map((f) => f()))) } : {}),
		refs: async (q) => Promise.all((await raw.refs(q)).map(ref)),
		async get(id) {
			const r = await raw.get(id);
			return r ? full(r) : null;
		},
		...(raw.live ? { live: raw.live } : {}),
		...(groups ? { groups } : {})
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
 * (e.g. a CMS adapter that maps its JSON shape to what `blocks()`/`markdown()` expect). Threads
 * `init`/`live`/`groups` through unchanged.
 */
export function mapRaw<A, B>(src: RawSource<A>, fn: (value: A) => B): RawSource<B> {
	return {
		...(src.init ? { init: src.init } : {}),
		...(src.live ? { live: src.live } : {}),
		...(src.groups ? { groups: src.groups } : {}),
		async get(id) {
			const r = await src.get(id);
			return r ? { ...r, value: fn(r.value) } : null;
		},
		async refs(q) {
			return (await src.refs(q)).map((r) => ({ ...r, value: fn(r.value) }));
		}
	};
}

// NB: no `fromArray` / in-memory-array source is shipped — write a `{ refs, get }` object directly
// (or use `defineSource`) for fixtures or already-fetched records.
