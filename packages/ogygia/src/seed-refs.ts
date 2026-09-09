/**
 * SEED REFERENCES — island props that point into the page seed instead of copying it.
 *
 * THE DUPLICATION: on a csr=false page the handle ships `page.data` once as the page seed (so
 * islands can read `$page`), and every island ships its props as its own devalue sidecar. A CMS
 * page hands each block island its slice of the same `page.data` tree, so the same JSON crosses
 * twice — measured on one landing page: 674 KB of seed and 481 KB of props, of which 94% were
 * verbatim seed subtrees. Twice the bytes, and twice the server-side serialization (the larger
 * part of that page's remaining TTFB gap to a plain Kit render).
 *
 * THE CODEC: when the seed is going to ship, an island's props are serialized RELATIVE to it. Any
 * plain object / array in the props that is also a node of `page.data` — by IDENTITY (the app
 * passed the same object) or by STRUCTURE (the app cloned it: a JSON round-trip, a spread — the
 * Builder SDK does) — is written as `["OgygiaSeedRef", <path>]`, a path from `page.data` to that
 * node. The client revives the reference against the parsed seed and hands the island a deep
 * copy of the plain data (each island keeps owning its props, exactly as before; only the bytes
 * and the server work change). Largest matching ancestor wins, so a block whose whole props
 * object is one seed node becomes one short reference.
 *
 * WHAT MATCHES: plain objects and arrays whose subtree holds only plain objects, arrays, primitives
 * and Dates — no class instances (wired values, stores, snippets keep their own codec), no Maps or
 * Sets (the plain deep copy on the client would not reproduce them), no cycles. Small nodes are
 * skipped (`min_bytes`): a reference costs ~30 bytes, so it must save more than that.
 *
 * WHEN: only inside Kit's page pass of THIS document, and only once the request knows the seed
 * will ship (`seed_wanted`) — a reference into a seed that never arrives would be a hole in the
 * island's props. Islands rendered before the first `$page` reader on the page fall back to full
 * copies; that is deterministic per page, so fingerprints stay stable across renders. Every other
 * render root (a hole endpoint, a baked ticket, a foreign fragment) never references: its props
 * must be self-contained wherever the HTML is spliced.
 *
 * Universal module (no Node imports): the index + reducer run on the server, the resolver + clone
 * on the client, and the unit tests exercise both ends against a real devalue round trip.
 */
import { fnv1a } from './runtime/fingerprint.js';

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
	/** structural hash → the first seed node with that shape (structure matches: a clone). */
	readonly by_hash: Map<string, SeedNode>;
	/** nodes indexed (for tests / devtools). */
	readonly size: number;
}

/** A node the codec may reference: a plain object or an array (own prototype only). */
function is_plain(v: unknown): v is Record<string, unknown> | unknown[] {
	if (v === null || typeof v !== 'object') return false;
	if (Array.isArray(v)) return true;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

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

const index_cache = new WeakMap<object, SeedIndex>();

/**
 * Index the seed's `data` for referencing: every referenceable node at or above `min_bytes`, by
 * identity and by structural hash (first occurrence wins — the shortest path is not guaranteed,
 * the first in key order is, which is deterministic). Cached per `data` object: one index per
 * request, however many islands ask.
 */
export function index_seed(data: unknown, min_bytes = 96): SeedIndex {
	if (!is_plain(data)) return { by_identity: new WeakMap(), by_hash: new Map(), size: 0 };
	const hit = index_cache.get(data);
	if (hit) return hit;
	const by_identity = new WeakMap<object, SeedPath>();
	const by_hash = new Map<string, SeedNode>();
	const memo = new Map<object, { hash: string; bytes: number } | null>();
	let size = 0;
	const visit = (v: unknown, path: SeedPath, seen: Set<object>) => {
		if (!is_plain(v) || seen.has(v)) return;
		seen.add(v);
		const h = hash_subtree(v, memo, new Set());
		if (h && h.bytes >= min_bytes) {
			if (!by_identity.has(v)) by_identity.set(v, path);
			if (!by_hash.has(h.hash)) by_hash.set(h.hash, { node: v, path });
			size++;
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) visit(v[i], [...path, i], seen);
		} else {
			for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key], [...path, key], seen);
		}
	};
	visit(data, [], new Set());
	const index: SeedIndex = { by_identity, by_hash, size };
	index_cache.set(data, index);
	return index;
}

/**
 * A devalue reducer for one island's props: `(value) => path | undefined`. On first use it walks
 * the props once, top-down, largest matching ancestor first — identity first, then structure
 * (hash + exact comparison) — and remembers which objects to write as references. Nodes under a
 * matched ancestor are never visited (they ride inside the reference).
 */
export function seed_ref_reducer(
	index: SeedIndex,
	props: unknown,
	min_bytes = 96
): (value: unknown) => SeedPath | undefined {
	const matched = new WeakMap<object, SeedPath>();
	let walked = false;
	const walk = () => {
		walked = true;
		if (index.size === 0) return;
		const memo = new Map<object, { hash: string; bytes: number } | null>();
		const seen = new Set<object>();
		const visit = (v: unknown) => {
			if (!is_plain(v) || seen.has(v)) return;
			seen.add(v);
			const by_id = index.by_identity.get(v);
			if (by_id) {
				matched.set(v, by_id);
				return;
			}
			const h = hash_subtree(v, memo, new Set());
			if (h && h.bytes >= min_bytes) {
				const cand = index.by_hash.get(h.hash);
				if (cand && deep_equal_plain(cand.node, v)) {
					matched.set(v, cand.path);
					return;
				}
			}
			if (Array.isArray(v)) for (const item of v) visit(item);
			else for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key]);
		};
		visit(props);
	};
	return (value) => {
		if (value === null || typeof value !== 'object') return undefined;
		if (!walked) walk();
		return matched.get(value);
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

/** Client: a deep copy of the plain data (objects, arrays, Dates); anything else by reference.
 *  Each island owns its props — a mutation inside one island never reaches the seed or another
 *  island, exactly as with the copied sidecars before. */
export function clone_plain<T>(v: T): T {
	if (v instanceof Date) return new Date(v.getTime()) as T;
	if (Array.isArray(v)) return v.map(clone_plain) as T;
	if (is_plain(v)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(v)) out[key] = clone_plain((v as Record<string, unknown>)[key]);
		return out as T;
	}
	return v;
}

/** Client reviver for the devalue type: resolve + copy. A dangling path (no seed, or a seed that
 *  does not carry the node) revives to `undefined` and, in dev, says why. */
export function seed_ref_reviver(get_data: () => unknown): (path: SeedPath) => unknown {
	return (path) => {
		const node = resolve_seed_ref(get_data(), path);
		if (node === undefined && typeof console !== 'undefined' && import.meta.env?.DEV) {
			console.warn(
				`[ogygia] island props reference page.data at ${JSON.stringify(path)} but the page seed does not carry it — the island receives undefined there.`
			);
		}
		return clone_plain(node);
	};
}
