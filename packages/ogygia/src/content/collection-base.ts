/**
 * `Collection` — the browser-safe, stateful core behind `content()`. Holds a catalog of REFS (never
 * bodies), the graph (relations + backlinks), and the live lifecycle. It consumes a single
 * {@link Source} (`{ init?, refs, get, live?, groups? }`).
 *
 * The refs/get split is load-bearing here: the catalog is materialized from `source.refs()` — pure
 * metadata — so nav/weave/graph never fetch a body. A body is fetched exactly once, by `get(id)`, on
 * the read that renders it. Visibility (`filter`) is applied at READ time with an optional request
 * context, so the catalog stays a single unfiltered instance (no per-request cache to poison).
 */
import type { ContentRef, ContentRelations, Entry, RefEntry, SchemaLike } from './index.js';
import type { GroupMeta, Source, SourceEntry, SourceRef } from './source.js';
import { parseSchema } from './schema.js';

// ── content graph registry ───────────────────────────────────────────────────

/**
 * Every `Collection` registers here so relations resolve across collections and backlinks invert.
 * Build/server-side metadata — not per-request state.
 */
const GRAPH: { all: Set<Collection<Record<string, unknown>>> } = ((
	globalThis as Record<symbol, unknown>
)[Symbol.for('ogygia.content.graph')] ??= { all: new Set() }) as {
	all: Set<Collection<Record<string, unknown>>>;
};

/** Back-pointer from a public handle to its underlying `Collection` (relations resolve through it). */
export const COLLECTION = Symbol.for('ogygia.content.collection');

/** Resolve a relation value (a handle or a Collection) to its Collection, or undefined. */
function to_collection(value: unknown): Collection<Record<string, unknown>> | undefined {
	if (value instanceof Collection) return value as Collection<Record<string, unknown>>;
	if (value && typeof value === 'object') {
		const linked = (value as Record<symbol, unknown>)[COLLECTION];
		if (linked instanceof Collection) return linked as Collection<Record<string, unknown>>;
	}
	return undefined;
}

/** A relation frontmatter field is one id (string) or many (string[]). */
function ref_ids(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
	return [];
}
function to_ref(entry: ContentRef): RefEntry {
	return { id: entry.id, data: entry.data };
}

/** A request context threaded into the `filter` at read time (preview, roles). Flat + bounded. */
export type ReadContext = Record<string, unknown>;

/** Options for a `content()` collection. `loader` is a source; formats build the source. */
export type CollectionBaseOptions<
	Data extends Record<string, unknown> = Record<string, unknown>,
	Meta = Record<string, never>
> = {
	loader: Source<Meta>;
	/** One schema, or an ARRAY of schemas layered left→right (outputs merge; later wins on collision). */
	schema?: SchemaLike | SchemaLike[];
	filter?: (entry: ContentRef<Data, Meta>, ctx: ReadContext) => boolean;
	/**
	 * Relations to other collections — always a `(self) => object` callback. `self` is this
	 * collection's own handle, so a SELF relation is `related: self` with no reference to the `const`
	 * being defined (no type cycle, no annotation). One form, always.
	 */
	relations?: (self: unknown) => ContentRelations;
};

// ── the Collection ───────────────────────────────────────────────────────────

export class Collection<
	Data extends Record<string, unknown> = Record<string, unknown>,
	Meta = Record<string, never>
> {
	readonly #opts: CollectionBaseOptions<Data, Meta>;
	readonly #source: Source<Meta>;
	readonly #schema: SchemaLike[];
	readonly #catalog = new Map<string, ContentRef<Data, Meta>>();
	readonly #visible: (entry: ContentRef<Data, Meta>, ctx: ReadContext) => boolean;
	/** This collection's own handle (for the `relations: (self) => …` callback). */
	#self: unknown;
	#relationsDef: Record<string, unknown> = {};
	#relationNames: string[] = [];
	#relationsResolved = false;

	#startPromise: Promise<void> | null = null;
	#initPromise: Promise<void> | null = null;
	#version = 0;
	readonly #waiters = new Set<() => void>();
	#backlinkIndex: Map<string, RefEntry[]> | null = null;
	#backlinkKey: string | null = null;

	constructor(opts: CollectionBaseOptions<Data, Meta>) {
		if (!opts || opts.loader == null) throw new Error('[ogygia/content] content() requires `loader`');
		if (typeof opts.loader.refs !== 'function' || typeof opts.loader.get !== 'function') {
			throw new Error(
				'[ogygia/content] `loader` must be a source ({ refs, get }) — use markdown()/json()/blocks()/folder()/glob()'
			);
		}
		this.#opts = opts;
		this.#source = opts.loader;
		this.#schema = opts.schema == null ? [] : Array.isArray(opts.schema) ? opts.schema : [opts.schema];
		this.#visible = opts.filter ?? (() => true);
		GRAPH.all.add(this as unknown as Collection<Record<string, unknown>>);
	}

	/** Supply the collection's own handle for the `relations: (self) => …` callback. */
	bindSelf(self: unknown): void {
		this.#self = self;
	}

	#resolveRelations(): void {
		if (this.#relationsResolved) return;
		this.#relationsResolved = true;
		if (this.#opts.relations) {
			this.#relationsDef = this.#opts.relations(this.#self) as Record<string, unknown>;
			this.#relationNames = Object.keys(this.#relationsDef);
		}
	}

	get streaming() {
		return !!this.#source.live;
	}
	get fromIsFunction() {
		return !!this.#source.live || !!(this.#source as { dynamic?: boolean }).dynamic;
	}

	/** Directory/section decoration from the source, if it exposes any (`folder()` / a CMS folders API). */
	groups(): Promise<Map<string, GroupMeta>> {
		return this.#source.groups?.() ?? Promise.resolve(new Map());
	}

	/** AND-compose a per-remote filter onto collection visibility (narrow only). */
	compose(extra?: (entry: ContentRef<Data, Meta>) => boolean, ctx: ReadContext = {}) {
		return extra
			? (e: ContentRef<Data, Meta>) => this.#visible(e, ctx) && extra(e)
			: (e: ContentRef<Data, Meta>) => this.#visible(e, ctx);
	}

	#notify() {
		this.#version += 1;
		for (const wake of this.#waiters) wake();
	}

	snapshot() {
		return [...this.#catalog.values()];
	}
	version() {
		return this.#version;
	}

	async *watchChanges(): AsyncGenerator<number> {
		let seen = this.#version;
		while (true) {
			if (this.#version !== seen) {
				seen = this.#version;
				yield seen;
				continue;
			}
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.#waiters.delete(wake);
					resolve();
				};
				this.#waiters.add(wake);
			});
		}
	}

	/** Validate one source ref into a catalog ref. Schema layers (a genre stack like `fields.post` =
	 *  `[page, post_only]`) each validate the ORIGINAL frontmatter and their outputs MERGE left→right —
	 *  NOT chained. Chaining would let an early layer that returns only its own fields (e.g. `page`)
	 *  strip a field a later layer needs (e.g. `post`'s `date`) before it ever sees it. */
	async #normalizeRef(row: SourceRef<Meta>, seen?: Set<string>): Promise<ContentRef<Data, Meta>> {
		if (!row?.id || typeof row.id !== 'string') {
			throw new Error('[ogygia/content] source ref missing string id');
		}
		if (seen) {
			if (seen.has(row.id)) throw new Error(`[ogygia/content] duplicate id '${row.id}'`);
			seen.add(row.id);
		}
		const original = (row.data ?? {}) as Record<string, unknown>;
		let data: Record<string, unknown> = original;
		if (this.#schema.length) {
			data = {};
			for (const schema of this.#schema) {
				data = { ...data, ...(await parseSchema(schema, original, `content/${row.id}`)) };
			}
		}
		return {
			id: row.id,
			data: data as Data,
			meta: (row.meta ?? {}) as Meta,
			...(row.order !== undefined ? { order: row.order } : {}),
			...(row.filePath !== undefined ? { filePath: row.filePath } : {})
		};
	}

	/** Materialize the whole source (refs) into the catalog. Re-run on each live change. */
	async #reload(): Promise<void> {
		const rows = await this.#source.refs();
		const seen = new Set<string>();
		const next: ContentRef<Data, Meta>[] = [];
		for (const row of rows) next.push(await this.#normalizeRef(row, seen));
		this.#catalog.clear();
		for (const e of next) this.#catalog.set(e.id, e);
		this.#backlinkIndex = null;
		this.#notify();
	}

	/** Incremental live update: refetch just the changed ids (drop the ones the source no longer has). */
	async #reloadIds(ids: string[]): Promise<void> {
		for (const id of ids) {
			const row = await this.#source.get(id);
			if (row) this.#catalog.set(id, await this.#normalizeRef(row));
			else this.#catalog.delete(id);
		}
		this.#backlinkIndex = null;
		this.#notify();
	}

	#init(): Promise<void> {
		return (this.#initPromise ??= Promise.resolve(this.#source.init?.()).then(() => undefined));
	}

	#start(): Promise<void> {
		if (this.#startPromise) return this.#startPromise;
		this.#startPromise = (async () => {
			await this.#init();
			await this.#reload();
			if (this.#source.live) {
				const changes = this.#source.live();
				void (async () => {
					try {
						for await (const change of changes) {
							if (Array.isArray(change) && change.every((x) => typeof x === 'string')) {
								await this.#reloadIds(change as string[]);
							} else {
								await this.#reload();
							}
						}
					} catch (err) {
						console.error('[ogygia/content] live source failed:', err);
					}
				})();
			}
		})();
		return this.#startPromise;
	}

	async #loaded(): Promise<void> {
		await this.#start();
	}

	async ready() {
		await this.#loaded();
		return this.snapshot();
	}

	// ── graph ──────────────────────────────────────────────────────────────────

	relationTargets(): Record<string, Collection<Record<string, unknown>> | undefined> {
		this.#resolveRelations();
		const out: Record<string, Collection<Record<string, unknown>> | undefined> = {};
		for (const name of this.#relationNames) out[name] = to_collection(this.#relationsDef[name]);
		return out;
	}

	/** Visible ref by id (default context), or null. */
	lookup(id: string, ctx: ReadContext = {}): ContentRef<Data, Meta> | null {
		const e = this.#catalog.get(id);
		return e && this.#visible(e, ctx) ? e : null;
	}
	visibleRefs(ctx: ReadContext = {}): ContentRef<Data, Meta>[] {
		return this.snapshot().filter((e) => this.#visible(e, ctx));
	}

	async resolveGraph(entry: ContentRef<Data, Meta>) {
		const rel: Record<string, RefEntry | RefEntry[] | null> = {};
		const targets = this.relationTargets();
		for (const name of this.#relationNames) {
			const target = targets[name];
			const field = (entry.data as Record<string, unknown>)[name];
			const many = Array.isArray(field);
			if (!target) {
				rel[name] = many ? [] : null;
				continue;
			}
			await target.#loaded();
			const refs: RefEntry[] = [];
			for (const id of ref_ids(field)) {
				const e = target.lookup(id);
				if (e) refs.push(to_ref(e as ContentRef));
			}
			rel[name] = many ? refs : (refs[0] ?? null);
		}
		const index = await this.#backlinks();
		return { rel, backlinks: index.get(entry.id) ?? [] };
	}

	async #backlinks(): Promise<Map<string, RefEntry[]>> {
		const contributors: { src: Collection<Record<string, unknown>>; names: string[] }[] = [];
		for (const src of GRAPH.all) {
			const st = src.relationTargets();
			const names = Object.keys(st).filter((n) => (st[n] as unknown) === (this as unknown));
			if (names.length) contributors.push({ src, names });
		}
		await Promise.all(contributors.map((c) => c.src.#loaded()));
		const key = `${GRAPH.all.size}|` + contributors.map((c) => c.src.version()).join(',');
		if (this.#backlinkKey === key && this.#backlinkIndex) return this.#backlinkIndex;
		const index = new Map<string, RefEntry[]>();
		for (const { src, names } of contributors) {
			for (const se of src.visibleRefs()) {
				const ref = to_ref(se);
				for (const rname of names) {
					for (const id of new Set(ref_ids((se.data as Record<string, unknown>)[rname]))) {
						const list = index.get(id);
						if (list) list.push(ref);
						else index.set(id, [ref]);
					}
				}
			}
		}
		this.#backlinkKey = key;
		this.#backlinkIndex = index;
		return index;
	}

	#hasGraph(): boolean {
		this.#resolveRelations();
		if (this.#relationNames.length > 0) return true;
		for (const src of GRAPH.all) {
			if ((src as unknown) === (this as unknown)) continue;
			const t = src.relationTargets();
			for (const name in t) if ((t[name] as unknown) === (this as unknown)) return true;
		}
		return false;
	}

	async withGraph(entry: ContentRef<Data, Meta>): Promise<ContentRef<Data, Meta>> {
		if (!this.#hasGraph()) return entry;
		const { rel, backlinks } = await this.resolveGraph(entry);
		return { ...entry, rel, backlinks };
	}

	// ── read paths (browser-safe) ────────────────────────────────────────────────

	/** All visible refs (each graphed) — the corpus as metadata, never bodies. */
	async refs(ctx: ReadContext = {}): Promise<ContentRef<Data, Meta>[]> {
		return Promise.all((await this.ready()).filter((e) => this.#visible(e, ctx)).map((e) => this.withGraph(e)));
	}

	/** Build a full {@link Entry} (ref + body + source + graph) from a source `get`. */
	async #entryFrom(ref: ContentRef<Data, Meta>, full: SourceEntry<Meta> | null, rel: Record<string, RefEntry | RefEntry[] | null>, backlinks: RefEntry[]): Promise<Entry<Data, Meta>> {
		return {
			id: ref.id,
			data: ref.data,
			meta: ref.meta,
			...(full?.body !== undefined ? { body: full.body } : {}),
			...(full?.source !== undefined ? { source: full.source } : {}),
			rel,
			backlinks
		};
	}

	/** Resolve one entry to `{ id, data, meta, body, source, rel, backlinks }`, or `null`. */
	async get(id: string, ctx: ReadContext = {}): Promise<Entry<Data, Meta> | null> {
		if (!this.#hasGraph()) {
			// On-demand: a graph-less collection needs no catalog — fetch ONE full record.
			await this.#init();
			let ref = this.#catalog.get(id) ?? null;
			const full = await this.#source.get(id);
			if (!ref) {
				if (!full) return null;
				ref = await this.#normalizeRef(full);
			}
			if (!this.#visible(ref, ctx)) return null;
			return this.#entryFrom(ref, full, {}, []);
		}
		await this.#loaded();
		const ref = this.lookup(id, ctx);
		if (!ref) return null;
		const [full, graph] = await Promise.all([this.#source.get(id), this.resolveGraph(ref)]);
		return this.#entryFrom(ref, full, graph.rel, graph.backlinks);
	}
}
