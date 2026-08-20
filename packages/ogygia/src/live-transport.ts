/**
 * Transportable objects — `static [import.meta.og.wire]` codecs, as the hub's WIRE kind.
 *
 * A class instance normally cannot cross an island boundary (devalue rejects it). A class
 * opts in by declaring how it travels:
 *
 * ```ts
 * export class Cart {
 * 	items = $state<Item[]>([]);
 * 	add(item: Item) { this.items.push(item); }
 *
 * 	static wire = import.meta.og.wire({
 * 		encode: (c: Cart) => $state.snapshot(c.items),
 * 		decode: (items: Item[]) => Object.assign(new Cart(), { items })
 * 	});
 * }
 * ```
 *
 * `import.meta.og.wire()` is a COMPILE construct — the plugin consumes the member and mints the
 * key: `static [Symbol.for('ogygia.wire')] = <codec>`. No import, no value to pass around, and
 * STRICT: that member shape is the only legal position (build error anywhere else). ONE contract,
 * always explicit — `{ encode, decode }`, plus optional `id`/`merge` for session continuity.
 *
 * IDENTITY IS THE HUB'S (see ref.ts): mint memoizes one id per instance; the browser resolves
 * by id so five islands share one live object; `codec.id` names the ref into the session Keep
 * (a navigation reunites with the SAME instance, `codec.merge` reconciling fresh server data);
 * the server never remembers. This module owns only what is wire-SPECIFIC: the class registry
 * (build tag → class) and the codec protocol.
 */

import { slots } from './runtime/slots.js';
// EXPLICIT kind registration (never bare side-effect imports — the package marks JS
// side-effect-free, so a bundler tree-shakes those and the kind silently vanishes
// from client bundles; a CALLED import cannot be dropped).
import { register_snippet_kind } from './region-snippet.js';
import { register_store_kind, register_derived_kind } from './store-transport.js';
import { register_fn_kind } from './fn-transport.js';
import { register_kind, mint, resolve, REF_WIRE_KEY, type Ref } from './ref.js';

/** Feature entry: register every props-seam kind, then fill the `wire` slot so core resolves
 *  ANY transportable kind from `data-ogygia-props` through the one hub key. */
export function install() {
	register_wire_kind();
	register_snippet_kind();
	register_store_kind();
	register_fn_kind();
	register_derived_kind();
	slots.wire = {
		REF_WIRE_KEY,
		resolve: (ref: never, remember: boolean) => resolve(ref, remember)
	};
}

/** Reserved key for the static codec — what `import.meta.og.wire` rewrites to. `Symbol.for` so it's
 *  identical across every bundle. Internal: the public opt-in is the construct, not this symbol. */
export const wire = Symbol.for('ogygia.wire');

/** The codec `import.meta.og.wire({ … })` carries (or a static method returning it). */
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

/** A class carrying a transport codec (`{ encode, decode, … }`, or a static method returning one).
 *  ONE contract, always explicit — nothing inferred from class shape. */
interface TransportableClass {
	[wire]: (() => TransportCodec) | TransportCodec;
	name?: string;
}

interface WireRegistry {
	/** tag → class, filled by build-generated `__register_transportable` calls. */
	classes: Map<string, TransportableClass>;
	/** class → tag (reverse index for encode). */
	tags: WeakMap<object, string>;
}

const REGISTRY_KEY = Symbol.for('ogygia.transportables');

function wire_registry(): WireRegistry {
	const g = globalThis as Record<symbol, unknown>;
	return ((g[REGISTRY_KEY] as WireRegistry | undefined) ??= {
		classes: new Map(),
		tags: new WeakMap()
	});
}

/** Devalue custom-type name used for transportable payloads on the wire. */
export const TRANSPORT_WIRE_KEY = 'OgygiaT';

/** Legacy wire shape (`t` tag, `i` id, `d` data) — a hub Ref minus its kind discriminator. */
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
	const reg = wire_registry();
	reg.classes.set(tag, candidate);
	reg.tags.set(cls as unknown as object, tag);
}

function codec_of(cls: TransportableClass): TransportCodec {
	const raw = cls[wire];
	return typeof raw === 'function' ? raw.call(cls) : raw;
}

function class_for(tag: string | undefined): TransportableClass {
	const cls = tag === undefined ? undefined : wire_registry().classes.get(tag);
	if (cls === undefined) {
		throw new Error(
			`[ogygia] cannot revive transportable "${tag}": its class is not loaded on this side. ` +
				`The island must import the class as a VALUE (not \`import type\`) so its codec travels ` +
				`with the island's bundle.`
		);
	}
	return cls;
}

/** The hub kind: `[og.wire]` class instances. Identity/reunify/Keep live in the hub. */
export function register_wire_kind(): void {
	register_kind({
	k: 'wire',
	match(value) {
		const cls = (value as { constructor?: unknown }).constructor;
		return typeof cls === 'function' && !!(cls as unknown as TransportableClass)[wire];
	},
	encode(value) {
		const cls = value.constructor as unknown as TransportableClass;
		const tag = wire_registry().tags.get(cls as unknown as object);
		if (tag === undefined) {
			throw new Error(
				`[ogygia] class "${cls.name ?? '?'}" has a [import.meta.og.wire] codec but was never ` +
					`registered. Transportable classes must be declared in a module the ogygia vite plugin ` +
					`transforms (an \`export class\` in your app source, not node_modules or a dynamic eval).`
			);
		}
		return { t: tag, d: codec_of(cls).encode(value) };
	},
	decode(ref) {
		return codec_of(class_for(ref.t)).decode(ref.d);
	},
	keep_name(ref) {
		const codec = codec_of(class_for(ref.t));
		return typeof codec.id === 'string' ? codec.id : undefined;
	},
	merge(kept, ref) {
		const codec = codec_of(class_for(ref.t));
		if (typeof codec.merge === 'function') {
			codec.merge(kept as never, codec.decode(ref.d) as never);
		}
	}
});
}

const WIRE_ONLY = new Set(['wire']);

/**
 * Devalue reducer: encode a transportable instance, or return undefined to fall through to
 * devalue's normal handling. Same instance → same wire id (hub-memoized), which is what lets
 * the client reunite every copy of the prop into one live object.
 */
export function reduce_transportable(value: unknown): TransportPayload | undefined {
	register_wire_kind();
	const ref = mint(value, WIRE_ONLY);
	if (ref === undefined) return undefined;
	return { t: ref.t as string, i: ref.i, d: ref.d };
}

/**
 * Devalue reviver: rebuild a live instance from the wire payload via the hub.
 * `remember: true` (browser) memoizes by wire id + honors the session Keep; `remember: false`
 * (server, defer/streaming renders) always decodes fresh — per-request isolation.
 */
export function revive_transportable(payload: TransportPayload, remember: boolean): unknown {
	register_wire_kind();
	const ref: Ref = { k: 'wire', i: payload.i, t: payload.t, d: payload.d };
	return resolve(ref, remember);
}
