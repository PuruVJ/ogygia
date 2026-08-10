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
import { REGION_BRAND } from './region.js';

type EncodedRegion = {
	i: string; // id
	p: Record<string, unknown>; // props
	u: string; // signed url
	m: string; // hydrate module ('' for static)
	h?: string; // hydrate schedule
	g?: string; // hydrate margin
	x?: string; // server-rendered HTML baked into the ticket (awaited region) — swap, no fetch
};

export const ogygiaTransport = {
	Region: {
		encode(value: unknown): false | EncodedRegion {
			if (typeof value !== 'object' || value === null) return false;
			const f = value as Record<PropertyKey, unknown>;
			if (f[REGION_BRAND] !== true) return false;

			// Already a ticket (a re-serialized deferred region) — pass its fields through.
			if (f.kind === 'deferred') {
				return pack(f.id as string, f.props as Record<string, unknown>, f.url as string, f.module as string, f.hydrate as string, f.hydrateMargin as string, f.html as string);
			}
			// Dual region — sign now (this IS the moment of crossing) and drop the component. If it
			// was awaited, `html` is present and rides along so the client swaps with no fetch.
			if (f.kind === 'dual') {
				const sign = f.sign as (id: string, props: Record<string, unknown>) => string;
				const props = (f.props ?? {}) as Record<string, unknown>;
				return pack(f.id as string, props, sign(f.id as string, props), f.module as string, f.hydrate as string, f.hydrateMargin as string, f.html as string);
			}
			// Inline (plain component) — nothing prepared it to travel.
			throw new Error(
				'[ogygia] a held region reached the wire but its component is a plain import, so nothing ' +
					"built a chunk for it. Import that component `with { region: 'raw' }` (or a `wake:` mark) " +
					'to make it sendable.'
			);
		},
		decode(raw: EncodedRegion) {
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
