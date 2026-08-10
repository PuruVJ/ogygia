/**
 * Transportable objects — `static [ogygia.wire]` codecs.
 *
 * A class instance normally cannot cross an island boundary (devalue rejects it). A class
 * opts in by declaring how it travels:
 *
 * ```ts
 * import * as ogygia from 'ogygia';
 *
 * export class Cart {
 * 	items = $state<Item[]>([]);
 * 	add(item: Item) { this.items.push(item); }
 *
 * 	static [ogygia.wire] = {
 * 		encode: (c: Cart) => $state.snapshot(c.items),
 * 		decode: (items: Item[]) => Object.assign(new Cart(), { items })
 * 	};
 * }
 * ```
 *
 * Liveness comes from identity, not the codec: every encode of one instance mints ONE id,
 * and the browser memoizes decode by that id. Five islands receiving the same `cart` prop
 * therefore share one live client instance — `$state` fields inside it are reactive across
 * all of them. The server never memoizes (`remember: false`): each request decodes fresh so
 * nothing leaks between users (same guarantee island props already have).
 *
 * All registry state lives on `globalThis` under `Symbol.for` keys — the runtime and each
 * island entry are separate bundles, and per-module state would silently fork (the
 * nested-island context bug taught us this; see context.ts).
 */

import { slots } from './runtime/slots.js';

/** Feature entry: fill the `wire` slot so core revives transportables from `data-ogygia-props`. */
export function install() {
	slots.wire = { TRANSPORT_WIRE_KEY, revive_transportable };
}

/** Reserved key for the static codec. `Symbol.for` — identical across every bundle. */
export const wire = Symbol.for('ogygia.wire');

/** What `static [ogygia.wire]` holds (or a static method returning it). */
export interface TransportCodec<T = unknown, D = unknown> {
	/** Sending side: turn the live instance into devalue-safe data. */
	encode: (value: T) => D;
	/** Receiving side: rebuild a live instance from that data. */
	decode: (data: D) => T;
	/**
	 * CONTINUITY — a stable session name. Naming the codec promotes the instance from page
	 * lifetime to SESSION lifetime: it becomes a singleton in this browser tab, and a navigation
	 * reunites the next page's decode with the SAME live instance instead of rebuilding it. Tab-
	 * scoped only — the server stays per-request (never remembers), a reload starts fresh.
	 */
	id?: string;
	/**
	 * Reconcile a navigation: the tab already holds the live named instance and the new page's
	 * server snapshot just arrived (decoded as `fresh`). Apply whatever should carry over INTO
	 * `live` — its identity is preserved; `fresh` is discarded afterwards. Default: do nothing
	 * (live wins — continuity is the point; a cart mid-edit beats a server re-read). Override to
	 * pull server truth in (prices, stock, auth state).
	 */
	merge?: (live: T, fresh: T) => void;
}

/** A class carrying a transport codec (static method or static property). */
interface TransportableClass {
	[wire]: (() => TransportCodec) | TransportCodec;
	name?: string;
}

interface TransportRegistry {
	/** tag → class, filled by build-generated `__register_transportable` calls. */
	classes: Map<string, TransportableClass>;
	/** class → tag (reverse index for encode). */
	tags: WeakMap<object, string>;
	/** instance → minted wire id (one id per instance, however many props carry it). */
	ids: WeakMap<object, string>;
	/** wire id → live instance. Browser tab only — the server must never remember. */
	live: Map<string, object>;
	/**
	 * THE KEEP — session-lifetime instances by codec `id`. Survives SPA navigations (the runtime
	 * module is retained across body swaps); dies with the tab. Browser only: the server-side
	 * revive path (`remember: false`) never reads or writes it, so per-request isolation holds.
	 */
	keep: Map<string, object>;
	/** name → owning class tag, to detect two different classes claiming one continuity `id`. */
	keepOwner: Map<string, string>;
}

const REGISTRY_KEY = Symbol.for('ogygia.transportables');

function registry(): TransportRegistry {
	const g = globalThis as Record<symbol, unknown>;
	return ((g[REGISTRY_KEY] as TransportRegistry | undefined) ??= {
		classes: new Map(),
		tags: new WeakMap(),
		ids: new WeakMap(),
		live: new Map(),
		keep: new Map(),
		keepOwner: new Map()
	});
}

/** Devalue custom-type name used for transportable payloads on the wire. */
export const TRANSPORT_WIRE_KEY = 'OgygiaT';

/** Wire shape: tag identifies the class, id the instance, data the codec's encode output. */
interface TransportPayload {
	t: string;
	i: string;
	d: unknown;
}

/**
 * Register a class under a stable build-derived tag (root-relative module path + export
 * name). Called by generated code appended to every exported class in app source; a class
 * without a `[wire]` codec is silently skipped, so over-registration is harmless.
 */
export function __register_transportable(tag: string, cls: unknown): void {
	if (typeof cls !== 'function') return;
	const candidate = cls as unknown as TransportableClass;
	if (!candidate[wire]) return;
	const reg = registry();
	reg.classes.set(tag, candidate);
	reg.tags.set(cls as unknown as object, tag);
}

function codec_of(cls: TransportableClass): TransportCodec {
	const raw = cls[wire];
	return typeof raw === 'function' ? raw.call(cls) : raw;
}

function mint_id(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	// Ancient-runtime fallback; collision odds are irrelevant at tab scale.
	return 't' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/**
 * Devalue reducer: encode a transportable instance, or return undefined to fall through to
 * devalue's normal handling. Same instance → same wire id (memoized), which is what lets
 * the client reunite every copy of the prop into one live object.
 */
export function reduce_transportable(value: unknown): TransportPayload | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	const cls = (value as { constructor?: unknown }).constructor;
	if (typeof cls !== 'function') return undefined;
	const candidate = cls as unknown as TransportableClass;
	if (!candidate[wire]) return undefined;

	const reg = registry();
	const tag = reg.tags.get(cls as unknown as object);
	if (tag === undefined) {
		throw new Error(
			`[ogygia] class "${candidate.name ?? '?'}" has a [ogygia.wire] codec but was never ` +
				`registered. Transportable classes must be declared in a module the ogygia vite plugin ` +
				`transforms (an \`export class\` in your app source, not node_modules or a dynamic eval).`
		);
	}

	let id = reg.ids.get(value as object);
	if (id === undefined) {
		id = mint_id();
		reg.ids.set(value as object, id);
	}
	return { t: tag, i: id, d: codec_of(candidate).encode(value) };
}

/**
 * Devalue reviver: rebuild a live instance from the wire payload.
 *
 * `remember: true` (browser) memoizes by wire id — decoding the same handle twice returns
 * the SAME instance, which is the entire liveness mechanism. `remember: false` (server,
 * defer/streaming renders) always decodes fresh: memoizing across requests would leak one
 * user's state into another's HTML.
 */
/** Bound on `live` (wire-id → instance): each navigation aliases a fresh id to a kept object, so
 * without a cap the map would creep for the tab's lifetime. Old ids belong to past pages — evicting
 * them can never break the current page's same-instance reunion. */
const MAX_LIVE = 1024;

function remember_live(reg: TransportRegistry, id: string, instance: object): void {
	reg.live.set(id, instance);
	while (reg.live.size > MAX_LIVE) {
		const oldest = reg.live.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		reg.live.delete(oldest);
	}
}

export function revive_transportable(payload: TransportPayload, remember: boolean): unknown {
	const { t, i, d } = payload;
	const reg = registry();
	if (remember) {
		const existing = reg.live.get(i);
		if (existing !== undefined) return existing;
	}
	const cls = reg.classes.get(t);
	if (cls === undefined) {
		throw new Error(
			`[ogygia] cannot revive transportable "${t}": its class is not loaded on this side. ` +
				`The island must import the class as a VALUE (not \`import type\`) so its codec travels ` +
				`with the island's bundle.`
		);
	}
	const codec = codec_of(cls);

	// CONTINUITY: a named codec on the client is a session singleton in the Keep. If one already
	// lives there, decode the incoming payload as `fresh`, reconcile it INTO the live instance
	// (default: nothing — live wins), and hand back the SAME live object so identity is stable
	// across the navigation. First sighting: decode, and remember it under the name.
	// `remember: false` is the SERVER — it must never touch the Keep (per-request isolation).
	if (remember && typeof codec.id === 'string') {
		const name = codec.id;
		// Collision guard: two DIFFERENT classes claiming one continuity `id` would share a Keep slot
		// and silently reuse each other's instance. Warn (dev) — the name should be unique per class.
		const owner = reg.keepOwner.get(name);
		if (owner === undefined) reg.keepOwner.set(name, t);
		else if (owner !== t && typeof console !== 'undefined') {
			console.error(
				`[ogygia] two transportable classes both use continuity id "${name}" ("${owner}" and "${t}"). ` +
					`A continuity id must be unique per class — rename one, or they will clobber each other in the session Keep.`
			);
		}
		const kept = reg.keep.get(name);
		if (kept !== undefined) {
			if (typeof codec.merge === 'function') {
				const fresh = codec.decode(d);
				codec.merge(kept as never, fresh as never);
			}
			// The Keep is the source of truth for the name; wire ids in this payload alias it too,
			// so late-hydrating islands on the same page reunite with the same object.
			remember_live(reg, i, kept);
			return kept;
		}
		const instance = codec.decode(d);
		if (instance !== null && typeof instance === 'object') {
			reg.keep.set(name, instance as object);
			remember_live(reg, i, instance as object);
		}
		return instance;
	}

	const instance = codec.decode(d);
	if (remember && instance !== null && typeof instance === 'object') {
		remember_live(reg, i, instance as object);
	}
	return instance;
}
