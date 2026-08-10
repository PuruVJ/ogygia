/**
 * `Collection` — the browser-safe, stateful core behind `content()`. Holds a catalog cache, the
 * graph (relations + backlinks), and the live lifecycle. It consumes a single {@link Source}
 * (`{ init?, get, list, ids, live? }`); every format (`mdsvex`, `json`, `blocks`, …) is just a
 * builder that produces one. Schema validation and relations layer on top of whatever the source
 * yields — the source never knows about them.
 */
import type { ContentEntry, ContentRelations, Entry, RefEntry, SchemaLike } from './index.js';
import type { Source, SourceEntry } from './source.js';
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
function to_ref(entry: ContentEntry): RefEntry {
	return { id: entry.id, data: entry.data };
}

/** Options for a `content()` collection. `from` is a source; formats build the source. */
export type CollectionBaseOptions<
	Data extends Record<string, unknown> = Record<string, unknown>,
	Meta = Record<string, never>
> = {
	loader: Source<Meta>;
	schema?: SchemaLike;
	filter?: (entry: ContentEntry<Data, Meta>) => boolean;
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
	readonly #catalog = new Map<string, ContentEntry<Data, Meta>>();
	readonly #visible: (entry: ContentEntry<Data, Meta>) => boolean;
	/** This collection's own handle (for the `relations: (self) => …` callback). */
	#self: unknown;
	/** Resolved relation definitions ({ name: target }) — computed lazily at first graph read so
	 * forward / mutual references resolve (every collection exists by then). */
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
		if (!opts || opts.loader == null) throw new Error('[@ogygia/content] content() requires `loader`');
		if (
			typeof opts.loader.get !== 'function' ||
			typeof opts.loader.list !== 'function' ||
			typeof opts.loader.ids !== 'function'
		) {
			throw new Error(
				'[@ogygia/content] `loader` must be a source ({ get, list, ids }) — use mdsvex()/json()/blocks()/… or glob()/fromArray()'
			);
		}
		this.#opts = opts;
		this.#source = opts.loader;
		this.#visible = opts.filter ?? (() => true);
		// Relations are always a `(self) => …` callback — resolved once the handle exists (bindSelf).
		GRAPH.all.add(this as unknown as Collection<Record<string, unknown>>);
	}

	/** Supply the collection's own handle for the `relations: (self) => …` callback. Called once by
	 * `content()` after the handle is built; the callback itself runs lazily at first graph read. */
	bindSelf(self: unknown): void {
		this.#self = self;
	}

	/** Run the relations callback once, at first graph read (so forward / mutual refs are defined). */
	#resolveRelations(): void {
		if (this.#relationsResolved) return;
		this.#relationsResolved = true;
		if (this.#opts.relations) {
			this.#relationsDef = this.#opts.relations(this.#self) as Record<string, unknown>;
			this.#relationNames = Object.keys(this.#relationsDef);
		}
	}

	/** A live source drives streaming re-reads (query-mode remotes + `live.*`). */
	get streaming() {
		return !!this.#source.live;
	}
	/** A dynamic (non-prerenderable) source — remotes default to query mode. */
	get fromIsFunction() {
		return !!this.#source.live || !!(this.#source as { dynamic?: boolean }).dynamic;
	}

	/** AND-compose a per-remote filter onto collection visibility (narrow only). */
	compose(extra?: (entry: ContentEntry<Data, Meta>) => boolean) {
		return extra ? (e: ContentEntry<Data, Meta>) => this.#visible(e) && extra(e) : this.#visible;
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

	/** Validate + shape one source record into a catalog entry (schema runs on `data`). */
	async #normalize(row: SourceEntry<Meta>, seen?: Set<string>): Promise<ContentEntry<Data, Meta>> {
		if (!row?.id || typeof row.id !== 'string') {
			throw new Error('[@ogygia/content] source entry missing string id');
		}
		if (seen) {
			if (seen.has(row.id)) throw new Error(`[@ogygia/content] duplicate id '${row.id}'`);
			seen.add(row.id);
		}
		const data = (await parseSchema(this.#opts.schema, row.data ?? {}, `content/${row.id}`)) as Data;
		return {
			id: row.id,
			data,
			meta: (row.meta ?? {}) as Meta,
			...(row.body !== undefined ? { body: row.body } : {}),
			...(row.filePath !== undefined ? { filePath: row.filePath } : {})
		};
	}

	/** Materialize the whole source into the catalog (list). Re-run on each live change. */
	async #reload(): Promise<void> {
		const rows = await this.#source.list();
		const seen = new Set<string>();
		const next: ContentEntry<Data, Meta>[] = [];
		for (const row of rows) next.push(await this.#normalize(row, seen));
		this.#catalog.clear();
		for (const e of next) this.#catalog.set(e.id, e);
		this.#backlinkIndex = null;
		this.#notify();
	}

	/** Incremental live update: refetch just the changed ids (drop the ones the source no longer has). */
	async #reloadIds(ids: string[]): Promise<void> {
		for (const id of ids) {
			const row = await this.#source.get(id);
			if (row) this.#catalog.set(id, await this.#normalize(row));
			else this.#catalog.delete(id);
		}
		this.#backlinkIndex = null;
		this.#notify();
	}

	/** Run the source's async `init()` once. Cheap for sources that need none. */
	#init(): Promise<void> {
		return (this.#initPromise ??= Promise.resolve(this.#source.init?.()).then(() => undefined));
	}

	/** Load once (init + full materialize), and, for a live source, watch for changes. */
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
							// A `string[]` yield reloads just those ids; anything else re-lists the whole source.
							if (Array.isArray(change) && change.every((x) => typeof x === 'string')) {
								await this.#reloadIds(change as string[]);
							} else {
								await this.#reload();
							}
						}
					} catch (err) {
						console.error('[@ogygia/content] live source failed:', err);
					}
				})();
			}
		})();
		return this.#startPromise;
	}

	/** Await the catalog being loaded (materialized) without copying it. */
	async #loaded(): Promise<void> {
		await this.#start();
	}

	/** Start (once) and return the visible-agnostic snapshot. */
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

	/** Visible entry by id, or null. */
	lookup(id: string): ContentEntry<Data, Meta> | null {
		const e = this.#catalog.get(id);
		return e && this.#visible(e) ? e : null;
	}
	visibleEntries(): ContentEntry<Data, Meta>[] {
		return this.snapshot().filter(this.#visible);
	}

	async resolveGraph(entry: ContentEntry<Data, Meta>) {
		const rel: Record<string, RefEntry | RefEntry[] | null> = {};
		const targets = this.relationTargets(); // resolves relations
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
				if (e) refs.push(to_ref(e as ContentEntry));
			}
			rel[name] = many ? refs : (refs[0] ?? null);
		}
		const index = await this.#backlinks();
		return { rel, backlinks: index.get(entry.id) ?? [] };
	}

	/** Inverted backlink index (id → who points here), memoized by contributing sources' versions. */
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
			for (const se of src.visibleEntries()) {
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

	/** Does this collection participate in the graph — has relations, or is something's target? */
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

	async withGraph(entry: ContentEntry<Data, Meta>): Promise<ContentEntry<Data, Meta>> {
		if (!this.#hasGraph()) return entry;
		const { rel, backlinks } = await this.resolveGraph(entry);
		return { ...entry, rel, backlinks };
	}

	// ── read paths (browser-safe) ────────────────────────────────────────────────

	async entries(): Promise<ContentEntry<Data, Meta>[]> {
		return Promise.all((await this.ready()).filter(this.#visible).map((e) => this.withGraph(e)));
	}
	async entry(id: string): Promise<ContentEntry<Data, Meta> | null> {
		await this.#loaded();
		const e = this.lookup(id);
		return e ? this.withGraph(e) : null;
	}
	async ids(): Promise<string[]> {
		// A graph-less, unfiltered collection can answer ids without materializing (a filter needs
		// each entry's data, so it forces a full load).
		if (!this.#opts.filter && !this.#hasGraph() && this.#catalog.size === 0) {
			await this.#init();
			return this.#source.ids();
		}
		return (await this.ready()).filter(this.#visible).map((e) => e.id);
	}
	async get(id: string): Promise<Entry<Data, Meta> | null> {
		// On-demand: a graph-less collection fetches ONE record, no full materialize.
		if (!this.#hasGraph()) {
			await this.#init();
			let e = this.#catalog.get(id) ?? null;
			if (!e) {
				const row = await this.#source.get(id);
				if (row) {
					e = await this.#normalize(row);
					this.#catalog.set(e.id, e);
				}
			}
			if (!e || !this.#visible(e)) return null;
			return { id: e.id, data: e.data, meta: e.meta, body: e.body, rel: {}, backlinks: [] };
		}
		await this.#loaded();
		const e = this.lookup(id);
		if (!e) return null;
		const { rel, backlinks } = await this.resolveGraph(e);
		return { id: e.id, data: e.data, meta: e.meta, body: e.body, rel, backlinks };
	}
}
