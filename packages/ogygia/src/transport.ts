/**
 * `ogygiaTransport` — the SvelteKit `transport` entry that lets a held region cross the wire.
 *
 * A held region holds a live component, which devalue can't serialize. This teaches the wire to carry
 * one: at **encode** (server → wire) it signs the capability and drops the component, sending just
 * the ticket; at **decode** (client) it rebuilds a `deferred` region. It fires only when a
 * held region actually crosses the wire — an inline region rendered in the same pass never touches it.
 *
 * Install once, in the app's UNIVERSAL hooks (kept separate from `ogygiaHandle`, which is
 * server-only), so no server code leaks into the client:
 *
 * ```ts
 * // src/hooks.ts
 * import { ogygiaTransport } from 'ogygia';
 * export const transport = { ...ogygiaTransport };
 * ```
 */
import { REGION_BRAND } from './region-brand.js';
import { frameAddress } from './frame.js';
import { ticket, write } from './runtime/frame-store.js';
import {
	register_kind,
	mint,
	resolve,
	ref_reducer,
	ref_reviver,
	REF_WIRE_KEY,
	type Ref
} from './ref.js';
import { register_wire_kind } from './live-transport.js';
import { register_store_kind, register_derived_kind } from './store-transport.js';
import { register_snippet_kind } from './region-snippet.js';
import { register_fn_kind } from './fn-transport.js';

type EncodedRegion = {
	i: string; // id
	p: Record<string, unknown>; // props
	u: string; // signed url
	m: string; // hydrate module ('' for static)
	h?: string; // hydrate schedule
	g?: string; // hydrate margin
	x?: string; // server-rendered HTML baked into the ticket (awaited region) — swap, no fetch
	/** HUB IDENTITY — minted per live region instance (one id however many payloads carry it).
	 *  The browser memoizes decode by it, so every consumer of one region value shares one
	 *  descriptor, and the future reconciler diffs by it. Absent on legacy payloads. */
	hi?: string;
};

/** The region ENCODE law (ticket pass-through / dual signs at crossing / awaited-inline bakes /
 *  inline-unawaited throws), byte-for-byte the pre-hub behavior. */
function encode_region(value: unknown): false | EncodedRegion {
	{
		if (typeof value !== 'object' || value === null) return false;
		const f = value as Record<PropertyKey, unknown>;
		if (f[REGION_BRAND] !== true) return false;

		// Already a ticket (a re-serialized deferred region) — pass its fields through.
		if (f.kind === 'deferred') {
			return pack(
				f.id as string,
				f.props as Record<string, unknown>,
				f.url as string,
				f.module as string,
				f.hydrate as string,
				f.hydrateMargin as string,
				f.html as string
			);
		}
		// Dual region — sign now (this IS the moment of crossing) and drop the component. If it
		// was awaited, `html` is present and rides along so the client swaps with no fetch.
		if (f.kind === 'dual') {
			const sign = f.sign as (id: string, props: Record<string, unknown>) => string;
			const props = (f.props ?? {}) as Record<string, unknown>;
			return pack(
				f.id as string,
				props,
				sign(f.id as string, props),
				f.module as string,
				f.hydrate as string,
				f.hydrateMargin as string,
				f.html as string
			);
		}
		// Inline region that was AWAITED — its SSR HTML is baked, so it crosses as an HTML-only
		// ticket: no chunk, no signer, nothing to fetch. The client swaps the markup in and the
		// runtime wakes any `<ogygia-region>` islands inside it (body-swap machinery). This is how
		// a content `body` (markdown/blocks) rides a remote: `await` it (ogygia's `doc` remote does).
		if (typeof f.html === 'string') {
			return pack(
				'',
				(f.props ?? {}) as Record<string, unknown>,
				'',
				'',
				undefined,
				undefined,
				f.html
			);
		}
		// Inline and NOT awaited — nothing prepared it to travel: no chunk, no signer, no HTML.
		throw new Error(
			'[ogygia] a held region reached the wire but its component is a plain import, so nothing ' +
				'built a chunk for it. `await` the region before returning it from a remote/load — an ' +
				'awaited region bakes its SSR HTML and crosses as an HTML-only ticket. Or import the ' +
				"component `with { region: 'raw' }` (or a `wake:` mark) to make it a signed, fetchable " +
				'capability. On a csr=false page you can also skip the wire entirely: call `get()` in a ' +
				'universal `+page.ts` load / the component — its data reaches the render by reference.'
		);
	}
}

/** The region DECODE law (single-flight frame write for baked HTML + deferred rebuild),
 *  byte-for-byte the pre-hub behavior. */
function decode_region(raw: EncodedRegion) {
	{
		// SINGLE-FLIGHT: an awaited region carries baked HTML (`x`). Writing it to the frame store
		// at its CALL address updates any region already mounted for that call — in place, no
		// fetch. So a command that returns `await region(C, props)` settles the write AND refreshes
		// every matching region in one response. Client-only (decode revives the wire value in the
		// browser); on the server the store is inert. An HTML-ONLY ticket (awaited inline region —
		// no capability url) has no frame address, so there is nothing to write; it renders where
		// it's placed instead.
		if (raw.x != null && raw.u && typeof document !== 'undefined') {
			const a = frameAddress(raw.u);
			write({ a, v: ticket(a), html: raw.x });
		}
		return {
			[REGION_BRAND]: true,
			kind: 'deferred' as const,
			id: raw.i,
			props: raw.p,
			url: raw.u,
			module: raw.m,
			...(raw.h ? { hydrate: raw.h } : {}),
			...(raw.g ? { hydrateMargin: raw.g } : {}),
			...(raw.x != null ? { html: raw.x } : {})
		};
	}
}

/** The hub kind: a held/dual/awaited region — the RENDERABLE Ref. `d` is the EncodedRegion.
 *  Decode is deliberately un-memoized at the legacy seam (the wrapper below passes ids through
 *  raw); hub-memoized region identity arrives with the one-key collapse, where it becomes the
 *  foundation for persistent regions (the reconciler resolves by id). */
export function register_region_kind(): void {
	register_kind({
		k: 'region',
		match(value) {
			return (value as Record<PropertyKey, unknown>)[REGION_BRAND] === true;
		},
		encode(value) {
			const packed = encode_region(value);
			if (packed === false) {
				// unreachable through mint (match gates), kept as a hard guard
				throw new Error('[ogygia] region kind claimed a non-region value');
			}
			return { d: packed };
		},
		decode(ref: Ref) {
			return decode_region(ref.d as EncodedRegion);
		}
	});
}

const REGION_ONLY = new Set(['region']);

/** Every hub family the ONE `OgygiaRef` transport entry carries (hub v2 phase Y — symmetry).
 *  Region stays in the list for decode-completeness, but the `Region` entry below is first in
 *  object order so regions still ENCODE through it (legacy `EncodedRegion` wire shape kept). */
const ALL_FAMILIES = new Set(['wire', 'store', 'snippet', 'fn', 'derived', 'region']);

function ensure_all_kinds(): void {
	register_wire_kind();
	register_store_kind();
	register_snippet_kind();
	register_fn_kind();
	register_derived_kind();
	register_region_kind();
}

/**
 * The SvelteKit `transport` entry (install once in universal hooks). TWO entries, ONE codec
 * underneath (hub v2 phase Y): `Region` preserves the legacy region wire shape/tag for
 * compatibility; `OgygiaRef` carries EVERY OTHER hub kind through the same `ref_reducer` /
 * `ref_reviver` the island seams use — so a universal `load` can put a store, wire class, fn or
 * resumable derived in `page.data`, and a remote function can take/return one, all by identity.
 * Kit routes remote args + load data through this same `transport`, so the symmetry is total.
 * Decode is REQUEST-scoped on the server (no `document`) — client-sent identity never memoizes
 * across requests — and PAGE-scoped in the browser (reunification).
 */
export const ogygiaTransport = {
	// FIRST in key order → Kit's first-match encode claims regions here, preserving the legacy
	// `EncodedRegion` wire shape + `hi` reunification. OgygiaRef below never sees a region on encode.
	Region: {
		encode(value: unknown): false | EncodedRegion {
			register_region_kind();
			if (typeof value !== 'object' || value === null) return false;
			if ((value as Record<PropertyKey, unknown>)[REGION_BRAND] !== true) return false;
			const ref = mint(value, REGION_ONLY);
			if (ref === undefined) return false;
			// carry the hub id: same live region instance → same `hi` in every payload
			return { ...(ref.d as EncodedRegion), hi: ref.i };
		},
		decode(raw: EncodedRegion) {
			register_region_kind();
			// REUNIFY in the browser when the payload carries a hub id: every consumer of one
			// region value resolves to ONE descriptor (and the reconciler can diff by `hi`).
			// A payload WITHOUT `hi` (legacy, or an html-only ticket from an older writer) must
			// never memoize — ids like '' would collide. The server always decodes fresh.
			const remember =
				typeof document !== 'undefined' && typeof raw.hi === 'string' && raw.hi.length > 0;
			return resolve({ k: 'region', i: raw.hi ?? (raw.i || ''), d: raw }, remember);
		}
	},
	// Everything else (wire/store/snippet/fn/derived) crosses Kit's wire by identity through the
	// one hub codec. Regions are already claimed above, so this only fires for the other kinds.
	[REF_WIRE_KEY]: {
		encode(value: unknown): Ref | false {
			ensure_all_kinds();
			return ref_reducer(ALL_FAMILIES)(value) ?? false;
		},
		decode(ref: Ref) {
			ensure_all_kinds();
			return ref_reviver(typeof document !== 'undefined')(ref);
		}
	}
};

function pack(
	id: string,
	props: Record<string, unknown>,
	url: string,
	module: string,
	hydrate?: string,
	hydrateMargin?: string,
	html?: string
): EncodedRegion {
	const out: EncodedRegion = { i: id, p: props, u: url, m: module };
	if (hydrate) out.h = hydrate;
	if (hydrateMargin) out.g = hydrateMargin;
	if (html != null) out.x = html;
	return out;
}
