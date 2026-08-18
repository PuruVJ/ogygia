/**
 * Region snippets — the snippet shape of a region. "Everything that crosses an island boundary is a
 * region; components and snippets are its two shapes; static freezes, live wakes."
 *
 * A snippet handed to a component is a function, so it can't cross an island boundary directly (devalue
 * can't stringify a function). A region snippet is a real Svelte snippet — same-graph `{@render}`
 * renders it inline — that also carries a serializable DESCRIPTOR and knows how to REVIVE on the far
 * side. One primitive, two modes:
 *
 *  - **live** — the compiler, at a snippet's DEFINITION site, compiles its body into an island ENTRY
 *    and constructs a live region snippet (`{ m:'live', e, p }`). It renders the entry inline on the
 *    server and HYDRATES it on the client, so the markup comes alive. This is the former "portable
 *    snippet" path, unchanged in behavior, now expressed as the live mode of this one primitive.
 *  - **static** — a PLAIN snippet reaching a boundary is FROZEN to its server-rendered HTML
 *    (`{ m:'static', h }`). The client adopts that HTML byte-for-byte; nothing re-runs. No compiler
 *    involvement, so it survives wrappers, re-exports, and a consumer swapping in their own component.
 *    Correct for markdown content (prose, code): static, never reactive.
 *
 * The boundary law lives in ONE place — {@link reduce_region_snippet}: a branded region snippet crosses
 * as its descriptor; a bare snippet is captured static; a parameterized snippet that can't be frozen
 * throws, loudly. Revival is its single inverse, {@link revive_region_snippet}. `createRawSnippet` is
 * isomorphic (server calls `render`, client calls `setup`), so one factory serves both legs of both
 * modes with no manual environment branch.
 */
import { createRawSnippet, hydrate, unmount, type Component, type Snippet } from 'svelte';
import { render as ssr_render } from 'svelte/server';
import { BROWSER } from 'esm-env';

/**
 * A hand-written SERVER component that renders a bare snippet: svelte has no public API to
 * stringify a snippet, but a server component is just `($$renderer, $$props) => void` and a server
 * snippet is `($$renderer) => void` — so the component simply invokes the snippet. Hand-written
 * (not a `.svelte` file) so this module stays importable from plain node (endpoints, tests)
 * without a svelte compiler in the loader.
 */
const RenderSnippet = (($$renderer: unknown, $$props: { s: Snippet }) => {
	($$props.s as unknown as (r: unknown) => void)($$renderer);
}) as unknown as Component;

/** Devalue custom-type name a region snippet crosses under (wire-stable; was `OgygiaS`). */
export const REGION_SNIPPET_WIRE_KEY = 'OgygiaS';

/** The serializable stand-in a region snippet crosses as, discriminated by mode. */
export type RegionSnippetDescriptor =
	| { m: 'live'; e: string; p: Record<string, unknown> } // entry url + captured props
	| { m: 'static'; h: string } // frozen server HTML (single-rooted)
	| { m: 'slot'; id: string }; // ADOPT the in-place `<ogygia-slot data-og-slot=id>` DOM range

/** A snippet stamped with its region descriptor. */
type RegionSnippet = Snippet & { __ogRegion?: RegionSnippetDescriptor };

// A single-root, layout-neutral wrapper so (a) `createRawSnippet` sees one root and (b) the SSR frame
// and the client's adopted node agree byte-for-byte. `display:contents` keeps it out of layout.
const WRAP_OPEN = '<ogygia-snippet style="display:contents">';
const WRAP_CLOSE = '</ogygia-snippet>';

/**
 * The ONE factory. Build a region snippet from its descriptor (+ the live entry when we're at its
 * definition site and it's in the same bundle). Handles both modes and both legs.
 */
function make(desc: RegionSnippetDescriptor, live_entry: Component | null = null): RegionSnippet {
	// SLOT: the server rendered the real children in-place inside `<ogygia-slot data-og-slot=id>`; this
	// pointer only ever revives on the CLIENT. Hydration ADOPTS the element at the render position
	// without calling `render` at all (svelte's raw-snippet hydration), so `render` only runs when the
	// island RE-CREATES the snippet later (e.g. an `{#if}` around `{@render children()}` toggling) —
	// capture the marked element's HTML NOW, while it is still in the pre-hydration DOM, so re-creates
	// re-inject the same markup (a nested `<ogygia-region>` inside re-wakes itself on reconnect).
	if (desc.m === 'slot') {
		const el = BROWSER ? document.querySelector(`ogygia-slot[data-og-slot="${desc.id}"]`) : null;
		const h = el ? (el as HTMLElement).outerHTML : slot_marker_open(desc.id) + SLOT_MARKER_CLOSE;
		const slot_snip = createRawSnippet(() => ({ render: () => h, setup: () => {} })) as RegionSnippet;
		slot_snip.__ogRegion = desc;
		return slot_snip;
	}
	// SERVER leg of a LIVE snippet: hand-written server snippet instead of `createRawSnippet` (whose
	// server form is just `renderer.push(render())` — a SYNC string, which forced the entry's SSR
	// through the sync renderer and made any top-level `await` inside the snippet body throw
	// `await_invalid`). Here the OUTER renderer is threaded through: in async SSR the entry renders
	// inside `renderer.child(async …)` — full async support, content assembles into the right position
	// out-of-order — and in sync SSR (or without the internal APIs) it falls back to the old inline
	// path byte-for-byte. `renderer.global.mode`/`child` are internal svelte APIs; the feature-detect
	// degrades safely if they move.
	if (!BROWSER && desc.m === 'live') {
		type ServerRenderer = { push(html: string): void; child(fn: (r: ServerRenderer) => unknown): unknown; global?: { mode?: string } };
		const server_snip = ((renderer: ServerRenderer, ...args: unknown[]) => {
			// Server snippet args arrive as raw values; forward call-time params as `__ogArgs`.
			const props = args.length ? { ...desc.p, __ogArgs: args } : desc.p;
			const can_async =
				!!live_entry && renderer?.global?.mode === 'async' && typeof renderer.child === 'function';
			if (can_async) {
				renderer.child(async (r) => {
					const out = await ssr_render(live_entry!, { props });
					r.push(WRAP_OPEN + out.body + WRAP_CLOSE);
				});
			} else {
				renderer.push(WRAP_OPEN + (live_entry ? ssr_render(live_entry, { props }).body : '') + WRAP_CLOSE);
			}
		}) as unknown as RegionSnippet;
		server_snip.__ogRegion = desc;
		return server_snip;
	}
	const snip = createRawSnippet((...params: Array<() => unknown>) => {
		// Snippet params arrive as getters (both legs). A live snippet forwards them to its entry as
		// `__ogArgs`, so a parameterized `{#snippet row(item)}` crosses alive and renders per call.
		const live_props = () =>
			desc.m === 'live' ? (params.length ? { ...desc.p, __ogArgs: params.map((g) => g()) } : desc.p) : {};
		return {
			render: () => {
				if (desc.m === 'static') return WRAP_OPEN + desc.h + WRAP_CLOSE;
				// live: inline the entry's SSR on the server; empty on the client (setup hydrates it).
				return WRAP_OPEN + (BROWSER || !live_entry ? '' : ssr_render(live_entry, { props: live_props() }).body) + WRAP_CLOSE;
			},
			setup: (el: Element) => {
				if (desc.m === 'static') return; // frozen: adopt the SSR HTML, nothing to boot
				let app: unknown;
				let dead = false;
				const boot = (Comp: Component) => {
					if (!dead) app = hydrate(Comp, { target: el, props: live_props() });
				};
				if (live_entry) boot(live_entry);
				else import(/* @vite-ignore */ (desc as { e: string }).e).then((m) => boot((m as { default: Component }).default));
				return () => {
					dead = true;
					if (app) unmount(app as never);
				};
			}
		};
	}) as RegionSnippet;
	snip.__ogRegion = desc;
	return snip;
}

/** Freeze a plain snippet to a static region snippet by SSR-rendering it once (SERVER only). A snippet
 *  that needs parameters can't be frozen — surface that as the actionable boundary error. */
function capture_static(snippet: Snippet): RegionSnippet {
	let body: string;
	try {
		body = ssr_render(RenderSnippet, { props: { s: snippet } }).body;
	} catch (e) {
		throw new Error(
			`[ogygia] a snippet can't cross an island boundary statically — ${e instanceof Error ? e.message : String(e)}. ` +
				`Two things can't be frozen to HTML: a snippet with PARAMETERS (name it as a {#snippet} so it ` +
				`crosses LIVE, or pass the data as serializable props), and — for now — children that contain a ` +
				`NESTED island (freezing re-renders it; keep nested islands out of frozen children until slot ` +
				`islands land).`
		);
	}
	return make({ m: 'static', h: body });
}

// ── live constructor: emitted by the compiler at a snippet's definition site (was `og_portable`) ──
/** Definition-site factory (compiler-emitted). A live region snippet: renders `Entry` inline in the
 *  same graph AND carries the descriptor so it can cross a boundary alive. */
export function og_portable(Entry: Component, props: Record<string, unknown>, url: string): RegionSnippet {
	return make({ m: 'live', e: url, p: props }, Entry);
}

// ── public API: `region.snippet()` — pure runtime, static by default, mirrors `createRawSnippet` ──
export interface RawRegionSnippet {
	/** Single-root HTML for SSR + hydration match (same rule as `createRawSnippet`). */
	render: (...captures: unknown[]) => string;
	/** Client behavior after mount/adoption. DROPPED if this snippet is reduced across a wire. */
	setup?: (root: Element, ...captures: unknown[]) => (() => void) | void;
	/** Devalue-serializable inputs — same law as island props. */
	captures?: unknown[];
}

/** Lift a parameterless snippet, or a raw `{ render, setup?, captures? }`, into a region snippet. */
export function region_snippet(input: Snippet | RawRegionSnippet): RegionSnippet {
	// Lifting a bare snippet freezes it via SSR (`render`) — a server-only capture. Guarding the
	// client path keeps `svelte/server` out of the client graph (the raw `{render,setup}` form below
	// is fully client-safe and is what an island actually revives from).
	if (typeof input === 'function' && !BROWSER) return capture_static(input as Snippet); // lift form
	if (typeof input === 'function') {
		throw new Error(
			'[ogygia] region_snippet(fn) freezes a snippet by server-rendering it — call it during SSR, ' +
				'not on the client. Pass a raw { render, setup } region snippet for client-constructed regions.'
		);
	}
	const caps = input.captures ?? [];
	const snip = createRawSnippet(() => ({
		render: () => WRAP_OPEN + input.render(...caps) + WRAP_CLOSE,
		setup: input.setup ? (el: Element) => void input.setup!(el, ...caps) : () => {}
	})) as RegionSnippet;
	// Reduced form carries the rendered HTML (setup can't cross a wire — it warns there, not here).
	snip.__ogRegion = { m: 'static', h: input.render(...caps) };
	return snip;
}

/**
 * Prepare an island's props for crossing: freeze each BARE snippet prop to a single-rooted static
 * region snippet, so the SAME value renders the island body AND serializes — the body HTML and the
 * revived client snippet then agree byte-for-byte, and hydration adopts cleanly. Server-only (uses SSR
 * capture). Already-branded (live) snippets and non-snippet values pass through untouched. Returns the
 * original object when nothing changed (no needless copy).
 */
export function prepare_region_props(props: Record<string, unknown>): Record<string, unknown> {
	if (BROWSER) return props; // freezing is an SSR capture; the client revives from the descriptor
	let out: Record<string, unknown> | null = null;
	for (const k in props) {
		const v = props[k];
		if (typeof v === 'function' && !(v as RegionSnippet).__ogRegion) {
			(out ??= { ...props })[k] = capture_static(v as Snippet);
		}
	}
	return out ?? props;
}

// ── slot mode: children cross by IN-PLACE render + client adoption (no capture, no double-render) ──
/** The SSR marker that fences an island's in-place children so the client can adopt exactly that range.
 *  `display:contents` keeps it layout-neutral. */
export function slot_marker_open(id: string): string {
	return `<ogygia-slot data-og-slot="${id}" style="display:contents">`;
}
export const SLOT_MARKER_CLOSE = '</ogygia-slot>';

/** Monotonic per-process id for slot markers. Page-unique within one SSR pass (all that matters — the id
 *  fences a marker to its payload pointer); cross-page repeats are harmless (separate documents). */
let _slot_seq = 0;
export function next_slot_id(): string {
	_slot_seq = (_slot_seq + 1) & 0x7fffffff;
	return 'og' + _slot_seq.toString(36);
}

/** The serialize-only stand-in for in-place children: a branded value the codec reduces to a `slot`
 *  descriptor. Never rendered (the server body renders the real children); on the client it revives to a
 *  snippet that ADOPTS the marked DOM range. */
export function slot_pointer(id: string): RegionSnippet {
	const snip = (() => {}) as unknown as RegionSnippet;
	snip.__ogRegion = { m: 'slot', id };
	return snip;
}

// ── the boundary law: one reduce, one revive, both modes ──
/** Codec encode. Branded region snippet → its descriptor; a bare snippet → frozen static; anything
 *  else falls through (devalue handles it, or errors as before). */
export function reduce_region_snippet(value: unknown): RegionSnippetDescriptor | undefined {
	if (typeof value !== 'function') return undefined;
	const branded = (value as RegionSnippet).__ogRegion;
	if (branded) return branded;
	// Freezing a bare snippet is an SSR capture (`render` from svelte/server). Encode only ever runs
	// on the server; guarding here lets the client DCE `capture_static` → `svelte/server` (~13kB) out
	// entirely. A branded (live) snippet still crosses fine on either side via the `branded` return.
	if (BROWSER) return undefined;
	return capture_static(value as Snippet).__ogRegion; // a plain snippet at the boundary freezes
}

/** Codec decode. Rebuild a live snippet from the descriptor (both modes). */
export function revive_region_snippet(desc: RegionSnippetDescriptor): RegionSnippet {
	return make(desc);
}
