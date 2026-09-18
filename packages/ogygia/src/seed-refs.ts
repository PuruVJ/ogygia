/**
 * SEED REFERENCES — island props that point into the page seed instead of copying it.
 *
 * THE DUPLICATION: on a csr=false page the handle ships `page.data` once as the page seed (so
 * islands can read `$page`), and every island ships its props as its own sidecar. A CMS page hands
 * each block island its slice of the same `page.data` tree, so the same JSON crosses twice —
 * measured on one landing page: 674 KB of seed and 481 KB of props, of which 94% were verbatim
 * seed subtrees. Twice the bytes, and twice the server-side serialization (the larger part of that
 * page's remaining TTFB gap to a plain Kit render).
 *
 * THE CODEC: when the seed ships, an island's props are serialized RELATIVE to it. Any plain
 * object / array in the props that is also a node of `page.data` — by IDENTITY (the app passed the
 * same object) or by STRUCTURE (the app cloned it: a JSON round-trip, a spread — CMS SDKs do) — is
 * written as `["OgygiaSeedRef", <path>]`, a path from `page.data` to that node. The client revives
 * the reference against the ONE parsed seed of its document (the same graph `page.data` reads —
 * `runtime/seeds.ts`) and hands the island the seed's own node, by reference: island props are a
 * snapshot either way, and the DEV mutation guard warns on a write into them. Largest matching
 * ancestor wins, so a block whose whole props object is one seed node becomes one short reference.
 *
 * WHAT MATCHES: plain objects and arrays whose subtree holds only plain objects, arrays, primitives
 * and Dates — no class instances (wired values, stores, snippets keep their own codec), no Maps or
 * Sets, no cycles. Small nodes are skipped (`min_bytes`): a reference costs ~30 bytes, so it must
 * save more than that.
 *
 * WHEN: only inside Kit's page pass of THIS document, and only when the seed ships — a reference
 * into a seed that never arrives would be a hole in the island's props. The decision is made ONCE
 * per request, when the document tail renders (server/props-wire.ts): every island on the page
 * gets references then, whichever rendered first. Every other render root (a hole endpoint, a
 * baked ticket, a foreign fragment) never references: its props must be self-contained wherever
 * the HTML is spliced.
 *
 * ONE WALK: `analyze` measures a tree once — byte estimate, referenceability, JSON-exactness, a
 * streamed promise inside — and memoises per node. The seed index, the props plan and the handle's
 * lane/streaming decisions all read that one walk (three separate walks of a 690 KB tree before).
 *
 * Universal module (no Node imports): the index + reducer run on the server, the resolver on the
 * client, and the unit tests exercise both ends against a real devalue round trip.
 */
import { fnv1a } from './runtime/hash.js';

/** The devalue type tag. */
export const SEED_REF_KEY = 'OgygiaSeedRef';

export type SeedPath = (string | number)[];

interface SeedNode {
	node: object;
	path: SeedPath;
}

export interface SeedIndex {
	/** node → its path (identity matches: the app passed the seed's own object). */
	readonly by_identity: WeakMap<object, SeedPath>;
	/** node → its byte estimate (the threshold check, without hashing). */
	readonly bytes: WeakMap<object, number>;
	/**
	 * The seed nodes with exactly this byte estimate — the only ones a props node of that size can
	 * be a clone of. Structure matching hashes just those few candidates (memoised per seed node)
	 * instead of the whole seed, so an app that passes the seed's own objects never hashes a seed
	 * node at all, and a cloning app hashes only what it has to.
	 */
	candidates(bytes: number): readonly SeedNode[];
	/** Structural hash of a seed node, memoised for the request. */
	hash_of(node: SeedNode): string | null;
	/** nodes indexed (for tests / devtools). */
	readonly size: number;
	/**
	 * SEED SHAPING: the top-level `page.data` keys under which a props node was matched
	 * (`plan_seed_refs` records the first path segment of every reference it plans). The handle
	 * dry-runs the tail against the FULL index before shaping, so a key no island's code reads but
	 * whose node an island's props point into still ships — a reference must have something to
	 * point at.
	 */
	readonly touched: Set<string>;
}

/** A node the codec may reference: a plain object or an array (own prototype only). */
function is_plain(v: unknown): v is Record<string, unknown> | unknown[] {
	if (v === null || typeof v !== 'object') return false;
	if (Array.isArray(v)) return true;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

const is_thenable = (v: unknown): boolean =>
	typeof (v as { then?: unknown } | null)?.then === 'function';

/** Leaves that a plain deep copy reproduces exactly. */
function is_leaf(v: unknown): boolean {
	return (
		v === null ||
		v === undefined ||
		typeof v === 'string' ||
		typeof v === 'number' ||
		typeof v === 'boolean' ||
		typeof v === 'bigint' ||
		v instanceof Date
	);
}

const leaf_text = (v: unknown): string =>
	v === undefined
		? 'u'
		: v === null
			? 'n'
			: v instanceof Date
				? 'd' + v.getTime()
				: typeof v + ':' + String(v);

/**
 * Post-order structural hash + byte estimate of a plain subtree. `null` when the subtree is not
 * referenceable (a non-plain value inside, or a cycle). Visits each node once per walk; results
 * are memoised in `memo` so a graph with shared nodes stays linear.
 */
function hash_subtree(
	v: unknown,
	memo: Map<object, { hash: string; bytes: number } | null>,
	on_stack: Set<object>
): { hash: string; bytes: number } | null {
	if (is_leaf(v)) {
		const t = leaf_text(v);
		return { hash: t, bytes: t.length };
	}
	if (!is_plain(v)) return null;
	const cached = memo.get(v);
	if (cached !== undefined) return cached;
	if (on_stack.has(v)) return null; // cycle
	on_stack.add(v);
	let bytes = 0;
	let acc = Array.isArray(v) ? 'A' : 'O';
	let ok = true;
	if (Array.isArray(v)) {
		for (const item of v) {
			const h = hash_subtree(item, memo, on_stack);
			if (!h) {
				ok = false;
				break;
			}
			acc += '|' + h.hash;
			bytes += h.bytes + 1;
		}
	} else {
		for (const key of Object.keys(v).sort()) {
			const h = hash_subtree((v as Record<string, unknown>)[key], memo, on_stack);
			if (!h) {
				ok = false;
				break;
			}
			acc += '|' + key + '=' + h.hash;
			bytes += key.length + h.bytes + 3;
		}
	}
	on_stack.delete(v);
	// hash the accumulated child hashes (bounded per node — children contribute 16 chars each)
	const result = ok ? { hash: fnv1a(acc), bytes } : null;
	memo.set(v, result);
	return result;
}

/** Exact structural equality for the shapes `hash_subtree` accepts — the check behind a hash hit. */
export function deep_equal_plain(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a instanceof Date || b instanceof Date)
		return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	if (is_leaf(a) || is_leaf(b)) return false;
	if (!is_plain(a) || !is_plain(b)) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deep_equal_plain(a[i], b[i])) return false;
		return true;
	}
	const ka = Object.keys(a as object);
	const kb = Object.keys(b as object);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
		if (!deep_equal_plain((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
			return false;
	}
	return true;
}

/** What one walk learns about a subtree. */
export interface Measure {
	/** Byte estimate of the subtree's serialized form (a threshold input, not an exact count). */
	readonly bytes: number;
	/** Referenceable: plain objects / arrays / plain leaves only, no cycle — a seed ref may point
	 *  at it and the client reads it back as the same plain data. */
	readonly ref: boolean;
	/** JSON-exact: `JSON.stringify` + `JSON.parse` reproduce it — no undefined, Date, bigint,
	 *  non-finite number, -0, class instance, Map/Set, cycle. What picks the JSON lane. */
	readonly json: boolean;
	/** A thenable somewhere inside (a streamed load promise the handle must stage or settle). */
	readonly thenable: boolean;
}

// Shared leaf measures — one object per leaf class, never one per leaf (a CMS tree is mostly
// leaves; strings are sized inline by the walk).
const M_NULLISH_JSON: Measure = { bytes: 4, ref: true, json: true, thenable: false };
const M_UNDEFINED: Measure = { bytes: 4, ref: true, json: false, thenable: false };
const M_NUMBER: Measure = { bytes: 8, ref: true, json: true, thenable: false };
const M_NUMBER_NOJSON: Measure = { bytes: 8, ref: true, json: false, thenable: false };
const M_BIGINT: Measure = { bytes: 8, ref: true, json: false, thenable: false };
const M_DATE: Measure = { bytes: 24, ref: true, json: false, thenable: false };
const M_OPAQUE: Measure = { bytes: 0, ref: false, json: false, thenable: false };
const M_THENABLE: Measure = { bytes: 0, ref: false, json: false, thenable: true };
const M_CYCLE: Measure = M_OPAQUE;

/**
 * The one walk: measure a value (post-order, memoised per plain node in `memo`). Every child is
 * measured even after one disqualifies the parent: a clean sibling deeper in the tree must still
 * get its own entry (the index walk reads the memo). Strings never allocate a measure.
 */
function measure(v: unknown, memo: Map<object, Measure>, on_stack: Set<object>): Measure {
	switch (typeof v) {
		case 'string':
			return { bytes: v.length + 2, ref: true, json: true, thenable: false };
		case 'number':
			return Number.isFinite(v) && !Object.is(v, -0) ? M_NUMBER : M_NUMBER_NOJSON;
		case 'boolean':
			return M_NULLISH_JSON;
		case 'undefined':
			return M_UNDEFINED;
		case 'bigint':
			return M_BIGINT;
		case 'object':
			break;
		default:
			return M_OPAQUE; // function, symbol
	}
	if (v === null) return M_NULLISH_JSON;
	if (v instanceof Date) return M_DATE;
	if (!is_plain(v)) return is_thenable(v) ? M_THENABLE : M_OPAQUE;
	const cached = memo.get(v);
	if (cached !== undefined) return cached;
	// A plain-looking object carrying a SYMBOL key is a branded value (a held region, an og.$ fn
	// descriptor, a hub brand) that a devalue reducer claims: JSON would drop the brand and a seed
	// reference would copy it without one. Opaque, like a class instance.
	if (!Array.isArray(v) && Object.getOwnPropertySymbols(v).length > 0) {
		memo.set(v, M_OPAQUE);
		return M_OPAQUE;
	}
	if (on_stack.has(v)) return M_CYCLE;
	on_stack.add(v);
	let bytes = 0;
	let ref = true;
	let json = true;
	let thenable = false;
	const add = (c: unknown, key_len: number) => {
		if (typeof c === 'string') {
			bytes += c.length + 2 + key_len;
			return;
		}
		const m = measure(c, memo, on_stack);
		bytes += m.bytes + key_len;
		ref &&= m.ref;
		json &&= m.json;
		thenable ||= m.thenable;
	};
	if (Array.isArray(v)) {
		for (const item of v) add(item, 1);
	} else {
		for (const key in v) {
			const c = (v as Record<string, unknown>)[key];
			// An `undefined` PROPERTY keeps the JSON lane: `JSON.stringify` drops the key, and reading
			// it back gives `undefined` either way (only `key in obj` would tell — nothing on the wire
			// relies on that). One such leaf in a 690 KB CMS tree was pushing the whole seed onto the
			// devalue lane. An `undefined` ARRAY ELEMENT stays devalue: JSON would turn it into null.
			if (c === undefined) {
				bytes += key.length + 4;
				continue;
			}
			add(c, key.length + 3);
		}
	}
	on_stack.delete(v);
	const result: Measure = { bytes, ref, json, thenable };
	memo.set(v, result);
	return result;
}

interface Analysis {
	root: Measure;
	memo: Map<object, Measure>;
}

const analysis_cache = new WeakMap<object, Analysis>();

/** The walk, cached per plain root object: the seed's `page.data` is measured once per request
 *  however many islands, lanes and decisions ask; a props object once per island. */
function analysis(value: unknown): Analysis {
	if (!is_plain(value)) return { root: measure(value, new Map(), new Set()), memo: new Map() };
	const hit = analysis_cache.get(value);
	if (hit) return hit;
	const memo = new Map<object, Measure>();
	const a = { root: measure(value, memo, new Set()), memo };
	analysis_cache.set(value, a);
	return a;
}

/** What one walk says about a value (see {@link Measure}). */
export function analyze(value: unknown): Measure {
	return analysis(value).root;
}

const index_cache = new WeakMap<object, SeedIndex>();

/**
 * Index the seed's `data` for referencing: every referenceable node at or above `min_bytes`, by
 * identity now and by structural hash on demand (first occurrence wins — the shortest path is not
 * guaranteed, the first in key order is, which is deterministic). Cached per `data` object: one
 * index per request, however many islands ask. It reads the one measuring walk (`analyze`) and
 * prunes: a small clean node cannot hold a large child, so its subtree is skipped BEFORE its path
 * is materialised — on a CMS tree that is most of the nodes.
 */
export function index_seed(data: unknown, min_bytes = 96): SeedIndex {
	if (!is_plain(data))
		return {
			by_identity: new WeakMap(),
			bytes: new WeakMap(),
			touched: new Set(),
			candidates: () => [],
			hash_of: () => null,
			size: 0
		};
	const hit = index_cache.get(data);
	if (hit) return hit;
	const by_identity = new WeakMap<object, SeedPath>();
	const bytes = new WeakMap<object, number>();
	const measured = analysis(data).memo;
	const nodes: SeedNode[] = [];
	const seen = new Set<object>();
	// A node that is NOT referenceable (a class instance / Map / cycle inside) may still hold
	// clean children: descend. A small clean node cannot hold a large child: prune (no path).
	const prunable = (v: unknown): v is object => {
		if (!is_plain(v) || seen.has(v)) return true;
		const m = measured.get(v);
		return m === undefined || (m.ref && m.bytes < min_bytes);
	};
	const visit = (v: Record<string, unknown> | unknown[], path: SeedPath) => {
		seen.add(v);
		const m = measured.get(v)!;
		if (m.ref) {
			by_identity.set(v, path);
			bytes.set(v, m.bytes);
			nodes.push({ node: v, path });
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) {
				const c = v[i];
				if (!prunable(c)) visit(c as Record<string, unknown> | unknown[], [...path, i]);
			}
		} else {
			for (const key in v) {
				const c = v[key];
				if (!prunable(c)) visit(c as Record<string, unknown> | unknown[], [...path, key]);
			}
		}
	};
	if (!prunable(data)) visit(data, []);
	// Size buckets for structure matching; hashes memoised per seed node, computed on first ask.
	const by_bytes = new Map<number, SeedNode[]>();
	for (const n of nodes) {
		const b = bytes.get(n.node)!;
		const bucket = by_bytes.get(b);
		if (bucket) bucket.push(n);
		else by_bytes.set(b, [n]);
	}
	const hash_memo = new Map<object, { hash: string; bytes: number } | null>();
	const index: SeedIndex = {
		by_identity,
		bytes,
		touched: new Set(),
		candidates: (b) => by_bytes.get(b) ?? [],
		hash_of: (n) => hash_subtree(n.node, hash_memo, new Set())?.hash ?? null,
		size: nodes.length
	};
	index_cache.set(data, index);
	return index;
}

export interface SeedRefPlan {
	/** The devalue reducer for the `OgygiaSeedRef` type: `(value) => path | undefined`. */
	reducer: (value: unknown) => SeedPath | undefined;
	/** How many props nodes will cross as references (0 = serialize the canonical text instead). */
	count: number;
}

/**
 * Plan one island's references: walk the props once, top-down, largest matching ancestor first —
 * identity first (a pointer lookup per node, no hashing), then structure (hash + exact comparison,
 * only for a large plain node the seed does not own, and only against the seed nodes of exactly the
 * same byte size — usually none, or one). Nodes under a matched ancestor are never visited (they
 * ride inside the reference). The props' own measure memo is reused, so the plan adds no walk of
 * its own beyond the pointer lookups.
 */
export function plan_seed_refs(index: SeedIndex, props: unknown, min_bytes = 96): SeedRefPlan {
	const matched = new WeakMap<object, SeedPath>();
	let count = 0;
	if (index.size > 0) {
		const measured = analysis(props).memo;
		const hashed = new Map<object, { hash: string; bytes: number } | null>();
		const seen = new Set<object>();
		const visit = (v: unknown) => {
			if (!is_plain(v) || seen.has(v)) return;
			seen.add(v);
			const by_id = index.by_identity.get(v);
			if (by_id) {
				matched.set(v, by_id);
				index.touched.add(String(by_id[0]));
				count++;
				return;
			}
			const m = measure(v, measured, new Set());
			if (m.ref && m.bytes >= min_bytes) {
				const cands = index.candidates(m.bytes);
				if (cands.length) {
					const h = hash_subtree(v, hashed, new Set())?.hash ?? null;
					const cand = h ? cands.find((c) => index.hash_of(c) === h) : undefined;
					if (cand && deep_equal_plain(cand.node, v)) {
						matched.set(v, cand.path);
						index.touched.add(String(cand.path[0]));
						count++;
						return;
					}
				}
			}
			if (Array.isArray(v)) for (const item of v) visit(item);
			else for (const key in v) visit((v as Record<string, unknown>)[key]);
		};
		visit(props);
	}
	return {
		reducer: (value) =>
			value === null || typeof value !== 'object' ? undefined : matched.get(value),
		count
	};
}

/** Client: the node a path points at, or `undefined` when the seed does not have it. */
export function resolve_seed_ref(data: unknown, path: SeedPath): unknown {
	let cur: unknown = data;
	for (const key of path) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string | number, unknown>)[key];
	}
	return cur;
}

/**
 * Client reviver for the devalue type: resolve BY REFERENCE. The island receives the seed's own
 * node — the same object its `page.data` read would hand it, shared exactly the way `page.data`
 * already is between islands. A deep copy per reference (129 of them on a measured page) bought
 * nothing: island props are a snapshot either way, and the DEV mutation guard the runtime wraps
 * every island's props in (`PropMutationGuard`) already warns on a write into them. `get_data` is
 * called lazily, once per reviver — the first reference resolves the seed. A dangling path (no seed,
 * or a seed that does not carry the node) revives to `undefined` and, in dev, says why.
 */
export function seed_ref_reviver(get_data: () => unknown): (path: SeedPath) => unknown {
	let data: unknown;
	let resolved = false;
	return (path) => {
		if (!resolved) {
			data = get_data();
			resolved = true;
		}
		const node = resolve_seed_ref(data, path);
		if (node === undefined && typeof console !== 'undefined' && import.meta.env?.DEV) {
			console.warn(
				`[ogygia] island props reference page.data at ${JSON.stringify(path)} but the page seed does not carry it — the island receives undefined there.`
			);
		}
		return node;
	};
}
