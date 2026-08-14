/**
 * Held regions — a held render. A value you can pass around and render with `<Region of={f} />`.
 *
 * `region(Component, props)` produces one, props type-checked against the component.
 *
 * One value, three faces the renderer sees:
 * - **inline** — a plain component import. Renders in the current server pass. Cannot cross the wire
 *   (nothing prepared a chunk for it). SDUI composed in place.
 * - **dual** — a component imported `with { region: 'raw' }`. Server-side it holds BOTH the real
 *   component (renders inline, first paint) AND everything needed to sign a capability. Rendered in
 *   the same pass → inline. Serialized to the client → the {@link import('./hooks.js').ogygiaTransport}
 *   strips the component and signs a ticket, so it arrives as `deferred`.
 * - **deferred** — what a dual region becomes across the wire: a signed ticket the runtime fetches
 *   and (if interactive) hydrates. No component.
 */
import type { Component, ComponentProps } from 'svelte';
import { region_snippet } from './region-snippet.js';

/** Brand so the transport can recognize a region without false-matching plain objects. */
export const REGION_BRAND = Symbol.for('ogygia.region');

/** Schedule options for a held region. `wake` = when its JS runs; `margin` = IntersectionObserver
 * rootMargin for `wake: 'visible'`. Merged OVER the binding's baked schedule (from a `wake:` mark) —
 * anything set here WINS; a `region: 'raw'` binding bakes nothing, so this is the whole schedule. */
export type RegionOptions = { wake?: string; margin?: string };

/**
 * The `region()` schedule argument: a function handed the component's own props (its "generated
 * data") that returns the schedule. Always a function, never a bare object — the object case is the
 * baked `wake:` mark on the import. The function is for a registry of `region: 'raw'` components that
 * decides each one's timing from its data — e.g.
 * `region(block, data, (d) => ({ wake: d.interactive ? 'load' : undefined }))`.
 */
export type RegionSchedule<P = Record<string, unknown>> = (data: P) => RegionOptions;

/**
 * The region result types erase the component's prop type — `region()` type-checks props
 * against the component at the call site, so the stored value doesn't need to stay generic. Erasing
 * keeps every concrete region assignable to the bare {@link RegionValue} supertype (a `C` in both a
 * covariant `props` and a contravariant `component` position has no non-`any` supertype otherwise).
 */
type AnyComponent = Component<Record<string, unknown>>;

/** A plain component, renderable only in the current server pass. */
export type InlineRegion = {
	readonly [REGION_BRAND]: true;
	readonly kind: 'inline';
	readonly component: AnyComponent;
	readonly props: Record<string, unknown>;
};

/** A marked component: renders inline here, or becomes a signed ticket when it crosses the wire. */
export type DualRegion = {
	readonly [REGION_BRAND]: true;
	readonly kind: 'dual';
	readonly component: AnyComponent;
	readonly props: Record<string, unknown>;
	readonly id: string;
	readonly module: string;
	readonly hydrate?: string;
	readonly hydrateMargin?: string;
	/** Server signer, invoked by the transport at serialization. Never crosses the wire. */
	readonly sign: (id: string, props: Record<string, unknown>) => string;
	/**
	 * Server-only renderer, invoked when the region is **awaited** (see {@link region}). Renders
	 * the component to HTML on the server so the ticket can travel with its markup — no client fetch.
	 * Provided by the SSR region-binding leg; never crosses the wire.
	 */
	readonly renderHtml?: (props: Record<string, unknown>) => string | Promise<string>;
	/** Server-rendered HTML, present once the region has been awaited. Rides the wire in the ticket. */
	readonly html?: string;
};

/** A held region that arrived over the wire: a signed capability, no component. */
export type DeferredRegion = {
	readonly [REGION_BRAND]: true;
	readonly kind: 'deferred';
	readonly id: string;
	readonly props: Record<string, unknown>;
	/** Signed `/🏝️?id&props&exp&sig` capability the runtime fetches. */
	readonly url: string;
	/** Client hydrate-module URL, imported after the HTML swaps in; `''` for a static region. */
	readonly module: string;
	/** Wake schedule ('load' | 'idle' | 'visible' | media); absent for a static region. */
	readonly hydrate?: string;
	/** IntersectionObserver rootMargin when `hydrate` is `'visible'`. */
	readonly hydrateMargin?: string;
	/**
	 * Server-rendered HTML baked into the ticket (the region was awaited before it crossed). When
	 * present the runtime swaps it in immediately and morphs across updates — no fetch. Absent → the
	 * runtime fetches the signed `url` as usual.
	 */
	readonly html?: string;
};

export type RegionValue = InlineRegion | DualRegion | DeferredRegion;

/**
 * What {@link region} returns: a {@link RegionValue} you can render right now with `<Region of={…} />`,
 * AND a `PromiseLike<Region>` you can `await` to bake its server-rendered HTML into the ticket. In an
 * async generator (`query.live`) or async remote, `yield` / `return` awaits it for you.
 */
export type AwaitableRegion = RegionValue & PromiseLike<RegionValue>;

/** True for any value produced by {@link region} (or decoded from the wire). */
export function isRegion(value: unknown): value is RegionValue {
	return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[REGION_BRAND] === true;
}

/**
 * What a `with { region: 'raw' }` import is rewritten to. The SSR leg is dual-face — it carries the
 * component AND the signer; the client leg is metadata-only. Authors never see this; they pass the
 * imported binding straight to {@link region}.
 */
type RegionBinding = {
	__ogRegion: string;
	__module: string;
	__hydrate?: string;
	__hydrateMargin?: string;
	__component?: Component<Record<string, unknown>>;
	__sign?: (entry: string, props: Record<string, unknown>) => string;
	/** SSR-only: render the component to HTML (svelte/server). Used when a held region is awaited. */
	__renderHtml?: (props: Record<string, unknown>) => string | Promise<string>;
};

function isBinding(value: unknown): value is RegionBinding {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as RegionBinding).__ogRegion === 'string'
	);
}

/**
 * Make a held region with type-checked props.
 *
 * - A plain component import → an **inline** region (renders in this pass; can't cross the wire).
 * - A component imported `with { region: 'raw' }` → a **dual** region: inline where it's made,
 *   a signed ticket where it travels. Minting the marked form is server-only (the signer lives on
 *   the SSR leg) — call it in a load / remote / render context.
 *
 * **A dual region is awaitable.** `await region(Card, props)` renders the component to HTML on
 * the server and bakes it into the ticket, so the client swaps it in with no extra request. In an
 * async generator (`query.live`) or an async remote, `yield region(…)` / `return region(…)` is
 * awaited by the language, so the HTML travels automatically — LiveView over the channel you already
 * have. A held region you *don't* await renders inline where it lands (first paint, same SSR pass).
 */
export function region<C extends Component<never>>(
	component: C,
	props: ComponentProps<C>,
	opts?: RegionSchedule<ComponentProps<C>>
): AwaitableRegion {
	const p = (props ?? {}) as Record<string, unknown>;
	// The schedule arg is a `(data) => options` function (or absent) — call it with the props
	// ("generated data") so a registry of raw components can pick each one's timing from its data.
	const o = opts ? opts(props) : undefined;
	if (isBinding(component)) {
		if (!component.__component || !component.__sign) {
			throw new Error(
				'[ogygia] a `with { region: \'raw\' }` component must be turned into a region on the server ' +
					'(the signer lives server-side). Call region() in a load / remote / render context, ' +
					'not in client code.'
			);
		}
		// Schedule: the call's `wake` wins, else the binding's baked schedule (from a `wake:` mark). A
		// `region: 'raw'` binding bakes none, so the call sets it — that's how the descriptor stays reusable.
		const hydrate = o?.wake ?? component.__hydrate;
		const hydrateMargin = o?.margin ?? component.__hydrateMargin;
		const dual: DualRegion = {
			[REGION_BRAND]: true,
			kind: 'dual',
			component: component.__component,
			props: p,
			id: component.__ogRegion,
			module: component.__module,
			...(hydrate ? { hydrate } : {}),
			...(hydrateMargin ? { hydrateMargin } : {}),
			sign: component.__sign,
			...(component.__renderHtml ? { renderHtml: component.__renderHtml } : {})
		};
		return make_awaitable(dual);
	}
	const inline: InlineRegion = {
		[REGION_BRAND]: true,
		kind: 'inline',
		component: component as AnyComponent,
		props: p
	};
	// Inline regions aren't thenable at runtime; awaiting one returns it unchanged (`await` on a
	// non-thenable is a no-op). The type is uniform so `await region(…)` type-checks either way.
	return inline as AwaitableRegion;
}

/**
 * Give a dual region a non-enumerable `then` so `await`-ing it renders the component to HTML and
 * resolves to a plain (non-thenable) dual region carrying that HTML. Non-enumerable so a spread or
 * `devalue` walk never copies it (which would re-arm the thenable / try to serialize a function);
 * the transport reads only the data fields. A held region with no `renderHtml` (SSR leg absent) is left
 * un-awaitable — awaiting it would be a no-op and only masks a mis-wired build.
 */
function make_awaitable(dual: DualRegion): AwaitableRegion {
	if (!dual.renderHtml) return dual as AwaitableRegion;
	Object.defineProperty(dual, 'then', {
		enumerable: false,
		configurable: true,
		writable: true,
		value(
			onFulfilled?: ((value: DualRegion) => unknown) | null,
			onRejected?: ((reason: unknown) => unknown) | null
		) {
			const run = async (): Promise<DualRegion> => {
				// `renderHtml` (generated per binding) already prefixes the component's stylesheet
				// `<link>`s — the page never imported this server-picked component, so its CSS is on no
				// page stylesheet; the client hoists those links to <head>.
				const html = dual.renderHtml ? await dual.renderHtml(dual.props) : undefined;
				// Spread copies only enumerable own props → drops `then`, so the result is NOT a
				// thenable and `await` settles here instead of chaining forever.
				return { ...dual, ...(html != null ? { html } : {}) };
			};
			return run().then(onFulfilled, onRejected);
		}
	});
	return dual as AwaitableRegion;
}

// `region.snippet()` — the SNIPPET shape of a region, sibling of `region()` for components. Freeze a
// parameterless snippet to static server HTML, or build the raw `{ render, setup?, captures? }` form
// (mirrors Svelte's `createRawSnippet`). Pure runtime, passable, renderable with plain `{@render}`.
export namespace region {
	export const snippet = region_snippet;
}
