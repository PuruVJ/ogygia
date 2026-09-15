/**
 * The barrel index: for a resolved module id, the map `exported name → leaf` — the module and
 * name an importer can go to directly. Built by walking the barrel's re-exports through nested
 * barrels, `export *` fan-outs and `import … ; export { … }` bindings, with a cycle guard and an
 * `opaque` flag for the parts it cannot see (a star into something it cannot parse).
 *
 * Pure over an injected HOST (read a file, resolve a specifier, decide candidacy), so it is
 * unit-tested against fixture files with a tiny resolver and runs unchanged inside the Vite plugin
 * with `this.resolve`.
 *
 * CONCURRENCY: a bundler transforms hundreds of importers at once, and most of them ask for the same
 * few barrels. One build per barrel is kept in flight (`#pending`) and every concurrent caller awaits
 * it. A cycle is detected against the WALK STACK of the build that is running (a → b → a), never
 * against another build's in-flight state; when a walk meets a barrel some other walk is still
 * building, it does not wait (two walks waiting on each other would never finish) — it leaves that
 * name unresolved and marks its own map PROVISIONAL, so the map is served once but not cached, and
 * the next importer rebuilds it against the finished neighbour.
 */
import { analyze_exports, type ModuleShape } from './parse.js';

export interface Host {
	/** The module's source, or null when it cannot be read (virtual, binary, missing). */
	read(id: string): string | null;
	/** Resolve `spec` from `importer` to a file id; null when Vite cannot. */
	resolve(spec: string, importer: string): Promise<string | null>;
	/** May this resolved module be treated as a barrel at all? (matchers + node_modules policy) */
	candidate(id: string, spec: string): boolean;
	/** Is this module forced even though impure? */
	forced(id: string, spec: string): boolean;
	/** Is this module kept whatever it looks like? */
	kept(id: string, spec: string): boolean;
	/** Follow a star into node_modules? */
	follow_packages: boolean;
}

export type Leaf =
	/** `import { name } from id` (or `import local from id` when name is `default`) */
	| { id: string; name: string }
	/** `import * as local from id` */
	| { id: string; namespace: true };

export type Entry = Leaf | 'own' | 'ambiguous';

export interface ExportMap {
	id: string;
	/** the barrel's usable names */
	entries: Map<string, Entry>;
	/** pure barrel → the import can be dropped once every name moved; impure → kept for effects */
	pure: boolean;
	/** rewriting allowed at all (candidate, and pure or forced, and not kept) */
	rewritable: boolean;
	/** some names could not be seen (a star into the unparsable): unknown names stay on the barrel */
	opaque: boolean;
	/** every module this map depends on — a change to any of them invalidates the map */
	deps: Set<string>;
	/** built while a neighbour was still being built by another walk: served, not cached */
	provisional: boolean;
	/** ids on the walk stack this build ran into (a cycle): the map lacks THEIR names, so it is
	 *  cached only once the walk that owns them has closed the ring (the set is empty there) */
	cycles: Set<string>;
}

const STRIP_QUERY_RE = /[?#].*$/;
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;
const PARSABLE_RE = /\.(?:[cm]?[jt]sx?|svelte\.[jt]s)$/;

/** The walk in progress: the ids on the current recursion path (cycle detection). */
type Walk = Set<string>;

export class BarrelIndex {
	#host: Host;
	#maps = new Map<string, ExportMap | null>();
	#shapes = new Map<string, ModuleShape | null>();
	#pending = new Map<string, Promise<ExportMap | null>>();

	constructor(host: Host) {
		this.#host = host;
	}

	/** Drop every cached map/shape that depends on `id` (the file changed). */
	invalidate(id: string): void {
		const clean = id.replace(STRIP_QUERY_RE, '');
		this.#shapes.delete(clean);
		for (const [k, m] of this.#maps)
			if (k === clean || (m && m.deps.has(clean))) this.#maps.delete(k);
	}

	/** The parsed shape of a module (cached), or null when it cannot be read/parsed. */
	shape(id: string): ModuleShape | null {
		const clean = id.replace(STRIP_QUERY_RE, '');
		if (this.#shapes.has(clean)) return this.#shapes.get(clean)!;
		let shape: ModuleShape | null = null;
		if (PARSABLE_RE.test(clean)) {
			const code = this.#host.read(clean);
			if (code != null) shape = analyze_exports(code, clean); // syntax error / not ESM → null → opaque
		}
		this.#shapes.set(clean, shape);
		return shape;
	}

	/**
	 * The export map of a barrel, or null when the module is not a barrel the plugin may rewrite
	 * (not a candidate, impure and not forced, kept, unreadable). `spec` is the specifier the
	 * importer wrote — matchers see both. Concurrent callers share one build.
	 */
	async map(id: string, spec: string): Promise<ExportMap | null> {
		const clean = id.replace(STRIP_QUERY_RE, '');
		if (clean !== id) return null; // `?raw`, `?url`, a virtual query — never a barrel
		if (this.#host.kept(clean, spec)) return null;
		if (!this.#host.candidate(clean, spec)) return null;
		if (this.#maps.has(clean)) return this.#maps.get(clean)!;
		const pending = this.#pending.get(clean);
		if (pending) return pending;
		const shape = this.shape(clean);
		if (!shape) {
			this.#maps.set(clean, null);
			return null;
		}
		if (!shape.pure && !this.#host.forced(clean, spec)) {
			this.#maps.set(clean, null);
			return null;
		}
		return this.#start(clean, shape, new Set());
	}

	/** Begin one build for `id`, register it as in flight, cache the result unless provisional. */
	#start(id: string, shape: ModuleShape, walk: Walk): Promise<ExportMap> {
		const run = (async () => {
			try {
				const built = await this.#build(id, shape, walk);
				if (!built.provisional && built.cycles.size === 0) this.#maps.set(id, built);
				return built;
			} finally {
				this.#pending.delete(id);
			}
		})();
		this.#pending.set(id, run);
		return run;
	}

	async #build(id: string, shape: ModuleShape, outer: Walk): Promise<ExportMap> {
		const walk: Walk = new Set(outer);
		walk.add(id);
		const map: ExportMap = {
			id,
			entries: new Map(),
			pure: shape.pure,
			rewritable: true,
			opaque: false,
			deps: new Set([id]),
			provisional: false,
			cycles: new Set()
		};
		// Explicit exports first (they win over stars: the spec shadows a star's name with a local
		// export), stars after — a star never overrides an explicit name, and two stars with different
		// leaves for one name make it ambiguous (a SyntaxError to import per spec; we leave it on the
		// barrel). `explicit` also covers a name a re-export could not resolve: unknown, not star-filled.
		const stars: { source: string; type_only: boolean }[] = [];
		const explicit = new Set<string>();
		for (const rec of shape.exports) {
			if (rec.kind === 'own') {
				map.entries.set(rec.exported, 'own');
				explicit.add(rec.exported);
			} else if (rec.kind === 'reexport') {
				explicit.add(rec.exported);
				const leaf = await this.#leaf(id, rec.source, rec.imported, map, walk);
				if (leaf) map.entries.set(rec.exported, leaf);
				else map.opaque = true; // the target could not be resolved: that name stays on the barrel
			} else if (rec.kind === 'star_ns') {
				explicit.add(rec.exported);
				const target = await this.#host.resolve(rec.source, id);
				if (target)
					map.entries.set(rec.exported, { id: target.replace(STRIP_QUERY_RE, ''), namespace: true });
				else map.opaque = true;
			} else stars.push({ source: rec.source, type_only: rec.type_only });
		}
		for (const star of stars) {
			const target = await this.#host.resolve(star.source, id);
			if (!target || target !== target.replace(STRIP_QUERY_RE, '')) {
				map.opaque = true;
				continue;
			}
			if (!this.#host.follow_packages && NODE_MODULES_RE.test(target)) {
				map.opaque = true;
				continue;
			}
			map.deps.add(target);
			const names = await this.#star_names(target, map, walk);
			if (!names) {
				map.opaque = true;
				continue;
			}
			for (const [name, leaf] of names) {
				if (name === 'default') continue; // a star never re-exports default
				if (explicit.has(name)) continue;
				const existing = map.entries.get(name);
				if (existing === undefined) map.entries.set(name, leaf);
				else if (existing !== leaf && !same_leaf(existing, leaf)) map.entries.set(name, 'ambiguous');
			}
		}
		return map;
	}

	/** The leaf behind `import { imported } from source` written inside barrel `from`. */
	async #leaf(from: string, source: string, imported: string, map: ExportMap, walk: Walk): Promise<Leaf | null> {
		const target = await this.#host.resolve(source, from);
		if (!target) return null;
		if (target !== target.replace(STRIP_QUERY_RE, '')) return null; // `?raw` etc. — leave it
		map.deps.add(target);
		// The target may itself be a barrel: look THROUGH it. Its map, if it is one we may build
		// (pure), tells us the real leaf; otherwise the target IS the leaf.
		const inner = await this.#through(target, map, walk);
		if (inner) {
			const e = inner.entries.get(imported);
			if (e && e !== 'own' && e !== 'ambiguous') return e;
			if (e === 'ambiguous') return null;
			// 'own' or unknown: the target module is where the name lives (or the best we know)
		}
		return { id: target, name: imported };
	}

	/**
	 * Look through a nested module while building a map. Unlike `map()`, this does not require
	 * the nested module to be a CANDIDATE (an importer's rewrite policy) — only that it is pure:
	 * a pure nested barrel is transparent, an impure one is a leaf in its own right (its own code
	 * must run for the name to exist). On our own walk stack = a cycle (null); in flight on another
	 * walk = do not wait (null, and the parent becomes provisional).
	 */
	async #through(id: string, parent: ExportMap, walk: Walk): Promise<ExportMap | null> {
		if (this.#host.kept(id, id)) return null;
		if (this.#maps.has(id)) {
			const m = this.#maps.get(id) ?? null;
			if (m) for (const d of m.deps) parent.deps.add(d);
			return m;
		}
		if (walk.has(id)) {
			// a ring: the parent lacks this module's names until the build that owns it closes the
			// ring (a self-star is the trivial ring — nothing is missing)
			if (id !== parent.id) parent.cycles.add(id);
			return null;
		}
		if (this.#pending.has(id)) {
			parent.provisional = true;
			return null;
		}
		const shape = this.shape(id);
		if (!shape || !shape.pure) return null;
		const built = await this.#start(id, shape, walk);
		if (built.provisional) parent.provisional = true;
		for (const c of built.cycles) if (c !== parent.id) parent.cycles.add(c);
		for (const d of built.deps) parent.deps.add(d);
		return built;
	}

	/** Every non-default name `export * from target` contributes, mapped to its leaf. */
	async #star_names(target: string, parent: ExportMap, walk: Walk): Promise<Map<string, Leaf> | null> {
		const shape = this.shape(target);
		if (!shape) return null;
		const out = new Map<string, Leaf>();
		if (shape.pure) {
			const inner = await this.#through(target, parent, walk);
			if (!inner) return null;
			if (inner.opaque) parent.opaque = true;
			for (const [name, e] of inner.entries) {
				if (e === 'own') out.set(name, { id: target, name });
				else if (e !== 'ambiguous') out.set(name, e);
			}
			return out;
		}
		// an impure module: its own names live here; its re-exports still resolve through it
		for (const rec of shape.exports) {
			if (rec.kind === 'own') out.set(rec.exported, { id: target, name: rec.exported });
			else if (rec.kind === 'reexport') {
				const leaf = await this.#leaf(target, rec.source, rec.imported, parent, walk);
				if (leaf) out.set(rec.exported, leaf);
				else parent.opaque = true;
			} else if (rec.kind === 'star_ns') {
				const t = await this.#host.resolve(rec.source, target);
				if (t) out.set(rec.exported, { id: t.replace(STRIP_QUERY_RE, ''), namespace: true });
			} else {
				// a star inside an impure module: follow it too
				const t = await this.#host.resolve(rec.source, target);
				if (!t) {
					parent.opaque = true;
					continue;
				}
				parent.deps.add(t);
				const names = await this.#star_names(t, parent, walk);
				if (!names) {
					parent.opaque = true;
					continue;
				}
				for (const [n, leaf] of names) if (n !== 'default' && !out.has(n)) out.set(n, leaf);
			}
		}
		return out;
	}
}

function same_leaf(a: Entry, b: Entry): boolean {
	if (typeof a === 'string' || typeof b === 'string') return a === b;
	if ('namespace' in a || 'namespace' in b)
		return 'namespace' in a && 'namespace' in b && a.id === b.id;
	return a.id === b.id && a.name === b.name;
}
