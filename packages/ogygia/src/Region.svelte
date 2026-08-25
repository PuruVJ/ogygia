<script>
	/**
	 * The one wrapper. Every region — placed (`<C/>` with `wake`/`fill`/`none`) or held
	 * (`region(C, props)`) — renders through here. It absorbs the four old wrappers:
	 *
	 * - **island** (`__mode: 'island'`, or a held interactive dual) → `<ogygia-region wake=…>`: SSR the
	 *   component inline, self-hydrate on the schedule (csr=false). Was `Island.svelte`.
	 * - **server** (`__mode: 'server'`) → `<ogygia-region render="defer" when=… endpoint=…>`: mint a
	 *   signed capability, ship the fallback, let the runtime fetch the HTML (then optionally wake).
	 *   Was `ServerIsland.svelte`.
	 * - **lake** (`__mode: 'lake'`) → `<ogygia-region wake="none">`: frozen furniture inside an island,
	 *   lift/restore, optional `remount: 'swr'` endpoint. Was `LakeRegion.svelte`.
	 * - **held** (`of={RegionValue}`) → inline (same-pass SDUI), deferred (crossed the wire, signed
	 *   ticket), or live (ticket already carries HTML — swap then morph). An interactive **dual** held
	 *   value routes into the island branch, so held + placed interactivity share one code path.
	 *
	 * Server-island minting is routed through the `virtual:ogygia/region-endpoint` virtual (client-
	 * stubbed to `''`), so this component lives in the main `ogygia` graph without pulling `$app/server`
	 * into the browser. The runtime custom element (`core.ts`) is unchanged; only the `.svelte` wrappers
	 * collapsed into this file.
	 */
	import { untrack } from 'svelte';
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import hmrUrl from 'virtual:ogygia/dev-hmr-url';
	import { islandDeps, islandCss, contentCss } from 'virtual:ogygia/island-deps';
	import { makeRegionEndpoint, mintServerIsland, known_region_fps } from 'virtual:ogygia/region-endpoint';
	import { fingerprint_of } from './runtime/fingerprint.js';
	import { asset } from '$app/paths';
	import { building } from '$app/environment';
	import { page } from '$app/state';
	import { record_page } from './page-seed-registry.js';
	import { isNested, setNested, documentIsCsrTrue, claimRuntimeEmit, claim_region_css } from './context.js';
	import { REF_WIRE_KEY, ref_reducer } from './ref.js';
	// PULL-registration inside stringify_props (idempotent; no import-time side effects)
	import { register_wire_kind } from './live-transport.js';
	import { register_store_kind, register_derived_kind } from './store-transport.js';
	import { register_snippet_kind } from './region-snippet.js';
	import { register_fn_kind } from './fn-transport.js';
	import { prepare_region_props, slot_pointer, slot_marker_open, SLOT_MARKER_CLOSE, next_slot_id } from './region-snippet.js';
	import { isRegion } from './region.js';
	import LakeBoundary from './LakeBoundary.svelte';
	import SlotBoundary from './SlotBoundary.svelte';
	import { record_server_event } from './devtools/server-registry.js';

	// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
	const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

	/**
	 * Every prop is optional: a HELD usage passes only `of`, a PLACEMENT usage (the transform's
	 * wrappers) passes only the `__*` internals — so `<Region of={value} />` type-checks for consumers
	 * without the internal props.
	 * @type {{
	 *   of?: import('./region.js').RegionValue | Promise<import('./region.js').RegionValue>;
	 *   placeholder?: import('svelte').Snippet;
	 *   children?: import('svelte').Snippet;
	 *   __mode?: 'island' | 'server' | 'lake';
	 *   visible?: string | boolean; idle?: boolean; media?: string; load?: boolean; interaction?: boolean;
	 *   __keep?: string; __entry?: string; __component?: import('svelte').Component; __css?: unknown;
	 *   __props?: Record<string, unknown>; __defer?: string; __margin?: string; __hydrate?: string;
	 *   __hydrateMargin?: string; __module?: string; __cacheTtl?: number;
	 *   ogygiaFallback?: import('svelte').Snippet;
	 *   __remount?: string; __when?: string; __maxAge?: number; __onExpire?: 'empty' | 'fetch';
	 * }}
	 */
	let {
		// Held API: a `RegionValue` from `region()` (inline / dual / deferred), or a Promise of one
		// (a remote call: `of={search(q)}`) — the region owns the whole wait, `placeholder` fills it.
		of,
		// Not-ready UI: rendered while a Promise `of` is in flight AND while a client-painted region's
		// styled HTML is still arriving. Distinct from `children` (the rendered component's slot).
		placeholder,
		children,
		// Placement API (the transform's wrappers): `__mode` selects island / server / lake.
		__mode,
		// island
		visible,
		idle,
		media,
		load,
		interaction,
		__keep,
		// island + server shared
		__entry = '',
		__component,
		__css,
		__props,
		// server
		__defer = 'load',
		__margin,
		__hydrate,
		__hydrateMargin,
		__module = '',
		// Response cache max-age in seconds for this deferred hole (absent/0 → no-store). Signed at mint.
		__cacheTtl,
		ogygiaFallback,
		// lake
		__remount = 'cache',
		__when = 'load',
		__maxAge,
		__onExpire
	} = $props();

	// Keep entry `.svelte` imports alive for FOUC without rendering them (the virtual owns the tree).
	// svelte-ignore state_referenced_locally
	void __css;

	const LT = String.fromCharCode(60); // <
	const GT = String.fromCharCode(62); // >

	// ─────────────────────────────────────────────── held: resolve (Promise `of`) ──
	// `of` may be a Promise<RegionValue> (a remote call). Note an awaitable dual IS thenable too —
	// the brand tells a real region value apart from a bare promise. Whether a usage passes a value
	// or a promise is fixed per instance, so reading `of` once here is intentional.
	// svelte-ignore state_referenced_locally
	const of_is_promise = !!of && typeof (/** @type {{ then?: unknown }} */ (of).then) === 'function' && !isRegion(of);
	// A promise with no placeholder guarantees a blank window on first load (nothing to show while
	// the promise and its stylesheet resolve). The model is "loading UI lives on the region" — say so.
	// svelte-ignore state_referenced_locally
	if (of_is_promise && !placeholder && !children && import.meta.env && import.meta.env.DEV) {
		console.warn(
			'[ogygia] <Region of={promise}> has no `placeholder` — the region will sit empty until the ' +
				'promise resolves and its stylesheet loads. Add {#snippet placeholder()}…{/snippet} for the wait.'
		);
	}
	/** @type {import('./region.js').RegionValue | undefined} */
	let awaited = $state(undefined);
	// What every held branch below renders. A plain value resolves synchronously (SSR renders it in
	// this same pass — blocks/SDUI never see a placeholder). A promise resolves client-side only.
	const resolved = $derived(of_is_promise ? awaited : /** @type {import('./region.js').RegionValue | undefined} */ (of));
	$effect(() => {
		if (!of_is_promise) return;
		const p = /** @type {Promise<import('./region.js').RegionValue>} */ (of);
		let live = true;
		// LAG, don't clear: on a re-search `of` is a NEW promise — keep showing the previous value
		// until the new one lands, so the old content morphs instead of flashing through empty.
		Promise.resolve(p).then((r) => {
			if (live) awaited = r;
		});
		return () => {
			live = false;
		};
	});

	// A held interactive dual renders exactly like a placed island — same SSR-inline + self-hydrate —
	// so both feed the island branch. A held static dual (no schedule) renders bare, like inline.
	// These read fixed-per-instance props (`of`/`__mode` never change for a given wrapper), so reading
	// them once is intentional — not a missed reactive capture. A Promise `of` is never a dual here:
	// a promise resolves to a wire value (deferred) — only a same-pass VALUE can be a dual.
	// svelte-ignore state_referenced_locally
	const of_init = of_is_promise ? undefined : /** @type {import('./region.js').RegionValue | undefined} */ (of);
	const held_dual_island = !!(of_init && of_init.kind === 'dual' && of_init.hydrate);
	// svelte-ignore state_referenced_locally
	const is_island = __mode === 'island' || held_dual_island;
	// svelte-ignore state_referenced_locally
	const is_server = __mode === 'server';
	// svelte-ignore state_referenced_locally
	const is_lake = __mode === 'lake';

	// Capture the page snapshot for the island seed. On SSR this reads Kit's REAL `$app/state` page —
	// the only place the resolved load `data` is reachable (Kit merges it locally in render.js, never
	// on RequestState, and reading page in a hook throws). The handle records it into the
	// `application/ogygia-page` seed, so a hydrated island's `$page.data` / `.form` / `.error` /
	// `.status` are populated (boundary law: page.data crosses). No-op on the client (recorder unset;
	// the client `page` is already the shim seed), and a harmless no-op in an isolated server-island
	// endpoint render (no recorder installed there either). `untrack` — one snapshot read, no dep.
	if (typeof window === 'undefined') {
		untrack(() => {
			try {
				record_page({ data: page.data, form: page.form, error: page.error, status: page.status });
			} catch {
				/* isolated render without a live page — the recorder is unset there anyway */
			}
		});
	}

	// Nested rule (islands/server): a region inside an already-awake region hydrates with its parent,
	// so it degrades to a plain inline render. Read once at init (a wrapper's mode is fixed per usage).
	const nested = isNested();
	// csr=true rule (ISLANDS only): on a Kit-hydrated page an interactive region should render its
	// component INLINE in the Kit tree — no `<ogygia-region>`, no runtime — because Kit already
	// hydrates it. Same degradation as `nested`, gated by the csr context the transform injects into
	// csr=true route hosts. Server/deferred + lake regions are SERVER-DRIVEN UI, orthogonal to a
	// page's csr, so they are deliberately NOT degraded here (they keep their endpoint + runtime).
	// Does Kit hydrate this WHOLE document? (the leaf page's effective csr — the one fact that decides
	// it.) If so, every island degrades to a plain inline component on both legs: no `<ogygia-region>`,
	// no runtime claim, no FOUC. Server reads the build-time csr=true route map; client reads Kit's
	// bootstrap. Identical both legs, so the inline/island choice can never desync at hydrate.
	const is_csr = documentIsCsrTrue();
	// The island branch renders inline when nested OR on a csr=true page.
	const island_inline = nested || is_csr;
	if ((is_island || is_server) && !nested) setNested();

	/** Island props cross classes, stores, snippets, og.$ fns and resumable deriveds. */
	const PROP_FAMILIES = new Set(['wire', 'store', 'snippet', 'fn', 'derived']);

	/** @param {unknown} value @param {string} entry */
	function stringify_props(value, entry) {
		register_wire_kind();
		register_store_kind();
		register_snippet_kind();
		register_fn_kind();
		register_derived_kind();
		try {
			return stringify(value, { [REF_WIRE_KEY]: ref_reducer(PROP_FAMILIES) });
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			throw new Error(
				`[ogygia] island "${entry}": a captured prop is not serializable — ${detail}. ` +
					`Captured host values cross the boundary via devalue; functions/Promises cannot, and a ` +
					`class instance only can when the class declares a static [ogygia.wire] codec. ` +
					`Pass a serializable value, add a codec, or move that logic inside the island component.`
			);
		}
	}

	// ─────────────────────────────────────────────────────────── island branch ──
	// Normalized island inputs, from placement props OR a held dual. `as_dual` is the type-narrowed
	// reactive read of the dual value (a Promise `of` never lands here — see `held_dual_island`).
	const as_dual = $derived(
		/** @type {import('./region.js').DualRegion | undefined} */ (
			held_dual_island && resolved?.kind === 'dual' ? resolved : undefined
		)
	);
	const island_entry = $derived(as_dual ? as_dual.module : __mode === 'island' ? __entry : '');
	const island_component = $derived(as_dual ? as_dual.component : __component);
	const island_props = $derived(as_dual ? as_dual.props : __props);
	const island_children = $derived(children);

	// DEV diagnostic (declared HERE, after `island_entry`, so it never reads it in its temporal dead
	// zone): a nested island can't wake independently — warn that its strategy is ignored. Dead-code
	// eliminated in builds via the `import.meta.env.DEV` guard.
	if (nested && (is_island || is_server) && import.meta.env && import.meta.env.DEV) {
		const entry = untrack(() => (is_server ? __entry : island_entry));
		console.warn(
			is_server
				? `[ogygia] nested server island "${entry}" is inside another island; rendering it inline as a normal component ('server' strategy ignored).`
				: `[ogygia] nested island "${entry}" is inside another island; it hydrates with its parent (strategy ignored).`
		);
	}
	// Freeze bare snippet PROPS (named-snippet props) to static region snippets (server) so the island
	// BODY and the serialized PAYLOAD render byte-for-byte identically — hydration then adopts the frozen
	// HTML with no mismatch. A live (branded) snippet passes through; `nested` islands render inline, no
	// crossing, so untouched. CHILDREN are not frozen — they cross via the slot marker below.
	const island_props_ready = $derived(nested ? island_props : prepare_region_props(island_props));

	// ── slot crossing: an island's children render IN-PLACE, the client ADOPTS them ──
	// The marker id fencing THIS island's children to its payload pointer. Server-assigned; the client
	// reads it back from the serialized descriptor, never regenerates it.
	const slot_id = next_slot_id();
	const has_slot_children = $derived(!nested && island_children != null);
	// The BODY-side children: a server-convention snippet (`(renderer) => …`) that emits EXACTLY ONE
	// element — `<ogygia-slot>` wrapping the natural children — with no extra snippet-layer anchors.
	// That single-element contract is what lets the client's revived slot snippet ADOPT the SSR DOM
	// (svelte's raw-snippet hydration takes the element at the render position verbatim). SlotBoundary
	// resets the nested context so an island INSIDE the children renders as a full region (own
	// `<ogygia-region>` + payload) and wakes independently after adoption. Server-only by construction:
	// on a csr=false page the client never renders Region, it revives the payload's slot pointer.
	const slot_children = (renderer) => {
		renderer.push(slot_marker_open(slot_id));
		SlotBoundary(renderer, { children: island_children });
		renderer.push(SLOT_MARKER_CLOSE);
	};
	// Body props: children ride as a PROP (the island renders them via its own `{@render children()}`),
	// never as Region's template slot — a template slot would pass an implicit children snippet that both
	// OVERRIDES the prop and adds an extra `<!---->` anchor per layer, desyncing hydration.
	const island_props_body = $derived(
		has_slot_children && typeof window === 'undefined'
			? { ...island_props_ready, children: slot_children }
			: island_props_ready
	);
	// Wire props: the same children as a serializable slot POINTER the client revives into an adopting
	// snippet. Everything else is shared with the body, so both legs agree byte-for-byte.
	const island_props_wire = $derived(
		has_slot_children ? { ...island_props_ready, children: slot_pointer(slot_id) } : island_props_ready
	);
	// The `wake` value IS the strategy: 'load' | 'idle' | 'visible' | 'interaction' | a media query.
	const hydrate_attr = $derived(
		as_dual
			? as_dual.hydrate
			: media
				? media
				: idle
					? 'idle'
					: visible
						? 'visible'
						: interaction
							? 'interaction'
							: 'load'
	);
	const root_margin = $derived(
		as_dual
			? as_dual.hydrateMargin || undefined
			: typeof visible === 'string'
				? visible
				: undefined
	);

	// `asset()` is the sole base/assets authority — every ogygia URL is baked base-LESS (prod
	// `/${appDir}/immutable/…`, dev `/@id/…`) and resolved here once. (Kit dev serves `/@id/…` under
	// base, and `asset()` supplies that prefix — so we never special-case dev URLs.)
	const island_module_url = $derived(nested || !island_entry ? '' : asset(island_entry));

	const island_payload = $derived(
		nested ? '' : stringify_props(island_props_wire, island_entry).split(LT).join('\\u003C')
	);
	const island_props_script = $derived(
		LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + island_payload + LT + '/script' + GT
	);
	// SERVER-DELTA parity: the island's fingerprint, IDENTICAL to the client reconciler's
	// region_props_fp (entry attr + '' endpoint + props-seed text). Emitted as data-og-fp so the
	// client can send it back on nav and the server can skip re-rendering an unchanged island.
	const island_fp = $derived(
		is_island && !island_inline ? fingerprint_of(island_module_url, '', island_payload) : ''
	);
	// SERVER-DELTA (D3): SKIP rendering a NON-cached island the client already has live (its fp is
	// in the SPA nav's x-ogygia-known set). Emit the region's identifying attrs + props script but NO
	// component content — the reconciler keeps the live node (same data-key). Safe: known_region_fps()
	// is empty on a full load / non-SPA request, so this never fires except on an SPA nav.
	const island_skip = $derived(
		is_island && !island_inline && !has_slot_children && (__cacheTtl ?? 0) <= 0 && !!island_fp
			&& known_region_fps().has(island_fp)
	);

	// `wake: 'load'` — modulepreload facade + dep chunks in <head> so discovery is early.
	// `wake: 'visible'` / `wake: 'interaction'` — the SAME hints at `fetchpriority="low"`: the bytes
	// ride in the background (never contending with critical work), the module map is warm, and the
	// later `import()` (visible's idle warm, interaction's hover warm, or the real wake) is a pure
	// cache hit — modulepreload compiles into the module map with module CORS semantics, never a
	// double fetch. Execution still waits for the schedule; only bytes move early. Only SSR can do
	// this: the client knows just the facade URL; the dep closure lives in the islandDeps manifest.
	// Browsers without fetchpriority ignore the attribute (hints degrade to normal priority).
	// Media-query wakes stay unhinted — the server can't know the viewport, so downloading would be
	// a blind bet.
	const island_preload = $derived.by(() => {
		if (island_inline || !is_island || !island_module_url) return '';
		if (hydrate_attr !== 'load' && hydrate_attr !== 'visible' && hydrate_attr !== 'interaction')
			return '';
		const low = hydrate_attr === 'load' ? '' : ' fetchpriority="low"';
		const hrefs = [island_module_url];
		const add_with_deps = (entry, url) => {
			const own = url ? asset(url) : '';
			if (own && !hrefs.includes(own)) hrefs.push(own);
			for (const dep of islandDeps(entry)) {
				const href = asset(dep);
				if (href && !hrefs.includes(href)) hrefs.push(href);
			}
		};
		add_with_deps(island_entry, '');
		// Portable region-snippets riding THIS island's props come alive via `import(desc.e)` at
		// hydrate — preload their entries (+ deps) in the same breath. RENDER-GATED by construction:
		// the link exists iff the island that carries the snippet actually rendered (the compiler's
		// old static-scan emission preloaded every portable candidate in the host, rendered or not).
		// The payload embeds each descriptor's public entry URL; prod-shaped (dev has no preloads).
		// Match any appDir (`/<appDir>/immutable/og-region.<hash>.js`), not a hardcoded `/_app/`.
		for (const m of island_payload.match(/\/[^"\s]+\/immutable\/og-region\.[0-9a-f]+\.js/g) ?? []) {
			add_with_deps(m, m);
		}
		let html = '';
		for (const href of hrefs) html += LT + 'link rel="modulepreload" href="' + href + '"' + low + GT;
		return html;
	});

	// ─────────────────────────────────────────────────────────── server branch ──
	const server_endpoint = $derived.by(() => {
		if (!is_server || nested) return '';
		// Routed through the client-stubbed virtual (returns '' on the client); encodes, size-checks
		// (throws), and signs on the server. Same URL/MAC/TTL as every other mint path. `__cacheTtl`
		// (seconds, from the preset's `maxAge`) is signed in so the handle sets Cache-Control; absent
		// → 0 → the hole is served `no-store` (dynamic by default).
		return mintServerIsland(__entry, __props || {}, __cacheTtl || 0);
	});

	// DOM `entry`: the importable module URL a deferred island wakes with AFTER its HTML swaps in.
	// EMPTY for a static server island (`render: 'deferred'` with no `wake`) — it has no client module,
	// so there is nothing to import. Must not fall back to the region id: the router's next-page warm
	// scans `entry="…"` and `import()`s each as a module, so a bare id there fetches `/<id>` → 404 on
	// nav. The endpoint (which fetches the hole's HTML) is minted from `__entry` above, independently.
	const server_region_entry = $derived(!nested && __module ? asset(__module) : '');

	const server_payload = $derived(
		nested || !__hydrate ? '' : stringify_props(__props, __entry).split(LT).join('\\u003C')
	);
	const server_props_script = $derived(
		server_payload
			? LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + server_payload + LT + '/script' + GT
			: ''
	);

	const server_wants_modulepreload = $derived(
		!!__module &&
			!!__hydrate &&
			(__hydrate === 'load' ||
				__hydrate === __defer ||
				__hydrate === 'visible' ||
				__hydrate === 'interaction')
	);
	const server_modulepreload = $derived.by(() => {
		if (nested || !server_wants_modulepreload || !server_region_entry) return '';
		// Same low-priority background hints as `island_preload` for a phase-2 `visible`/`interaction`
		// hydrate.
		const low =
			(__hydrate === 'visible' || __hydrate === 'interaction') && __hydrate !== __defer
				? ' fetchpriority="low"'
				: '';
		const hrefs = [server_region_entry];
		for (const dep of islandDeps(__module)) {
			const href = asset(dep);
			if (href && !hrefs.includes(href)) hrefs.push(href);
		}
		let html = '';
		for (const href of hrefs) html += LT + 'link rel="modulepreload" href="' + href + '"' + low + GT;
		return html;
	});
	const server_fetch_preload = $derived.by(() => {
		// Only `defer: 'load'`: start the endpoint fetch during HTML parse (warms the per-hole load).
		if (nested || building || __defer !== 'load' || !server_endpoint) return '';
		const href_attr = server_endpoint.split('&').join('&amp;');
		return LT + 'link rel="preload" as="fetch" crossorigin="anonymous" href="' + href_attr + '"' + GT;
	});
	const server_preload = $derived(server_fetch_preload + server_modulepreload);

	// ───────────────────────────────────────────────────────────── lake branch ──
	// Lakes matter only inside an island (freeze + lift/restore). In the shell they render bare.
	const lake_inside = is_lake && nested;
	const lake_swr = $derived(__remount === 'swr');
	const lake_endpoint = $derived(
		lake_inside && lake_swr ? makeRegionEndpoint(__entry || '', __props || {}) : ''
	);

	// ─────────────────────────────────────────────── head (runtime + preload) ──
	// The runtime bootstrap for this page. Claim once, only for a top-level island/server placement
	// (lakes render inside an island; held regions rely on an existing runtime). With the router on,
	// the handle injects the same script on island-less pages — this is the with-islands path, and it
	// keeps islands hydrating even when the router is off (`ogygia({ router: false })`).
	const runtime_script =
		!nested && ((is_island && !is_csr) || is_server) && claimRuntimeEmit()
			? LT +
				'script type="module" data-ogygia-runtime src="' +
				asset(runtimeUrl) +
				'"' +
				GT +
				LT +
				'/script' +
				GT +
				(hmrUrl
					? LT +
						'script type="module" data-ogygia-dev-hmr src="' +
						asset(hmrUrl) +
						'"' +
						GT +
						LT +
						'/script' +
						GT
					: '')
			: '';
	// Held dual: the component was server-picked (a registry), so its CSS is on no page stylesheet —
	// Kit links CSS from the route's STATIC import graph, never from what actually rendered. This
	// render pass knows, so link it here: real `<link>`s into <head> via svelte:head, claimed
	// per-request so a page rendering five of the same block links its sheet once. Server-only —
	// `claim_region_css` returns [] on the client (SSR already emitted them).
	const region_css_html = $derived.by(() => {
		if (!resolved || resolved.kind !== 'dual' || !resolved.module) return '';
		let html = '';
		for (const href of claim_region_css(islandCss(resolved.module)))
			html += LT + 'link rel="stylesheet" href="' + asset(href) + '" data-ogygia-region-css' + GT;
		return html;
	});
	// A PLACED client island's CSS is ASSUMED to already sit in the page's own stylesheet (Kit links
	// a route's static import graph). But Rollup can chunk-split the marked component's CSS — notably
	// its `:global()` rules (a Bits UI dropdown trigger/menu, a scoped card) — into a route chunk this
	// page never loads, so the island renders unstyled in a production build. Link the island's own
	// CSS here, the SAME channel a held dual uses (`claim_region_css` dedups per-request, the client
	// hoists `data-ogygia-region-css` into <head>). Keyed by the raw `island_entry`, exactly like
	// `island_preload`'s `islandDeps` — not the asset URL. Server-only; dev routes through the same
	// module-import hoist (`islandCss` returns the dev module URL there).
	const island_css_html = $derived.by(() => {
		if (island_inline || __mode !== 'island' || !island_entry) return '';
		let html = '';
		for (const href of claim_region_css(islandCss(island_entry)))
			html += LT + 'link rel="stylesheet" href="' + asset(href) + '" data-ogygia-region-css' + GT;
		return html;
	});

	// A content BODY (an inline region from a `.svx`/`.md`) carries its own scoped `<style>`, but the
	// corpus is server-only so that CSS joins no page stylesheet — the same blind spot a held dual has,
	// one step further (there is no client module at all, just data). The markdown source baked a
	// `content_id`; resolve it through the handoff (`contentCss`) and link the client CSS asset the
	// plugin emitted, the SAME `data-ogygia-region-css` channel, deduped per-request by `claim_region_css`.
	const content_css_html = $derived.by(() => {
		if (resolved?.kind !== 'inline' || !resolved.content_id) return '';
		let html = '';
		for (const href of claim_region_css(contentCss(resolved.content_id)))
			html += LT + 'link rel="stylesheet" href="' + asset(href) + '" data-ogygia-region-css' + GT;
		return html;
	});

	const head_html = $derived(
		(is_island
			? runtime_script + island_preload + island_css_html
			: is_server
				? runtime_script + server_preload
				: '') +
			region_css_html +
			content_css_html
	);

	// ────────────────────────────────────────────────────── held: live / deferred ──
	const stringify_devalue = stringify;
	/** @param {Element & { applyLive?: (v: unknown) => void }} node */
	function apply_live(node) {
		// Reads `resolved`, so the attachment re-runs when a Promise `of` re-resolves — the mounted
		// region morphs to the new HTML instead of remounting (LAG keeps the old content meanwhile).
		const f = resolved;
		if (!f || f.kind !== 'deferred' || f.html == null) return;
		node.applyLive?.({
			id: f.id,
			module: f.module,
			props: f.props,
			html: f.html,
			url: f.url,
			hydrate: f.hydrate,
			hydrateMargin: f.hydrateMargin
		});
	}
	/** @param {import('./region.js').DeferredRegion} f */
	function identity(f) {
		try {
			return f.id + ' ' + stringify_devalue(f.props);
		} catch {
			return f.id;
		}
	}
	const held_props_script = $derived.by(() => {
		if (!resolved || resolved.kind !== 'deferred' || !resolved.hydrate || !resolved.url) return '';
		const payload = stringify_devalue(resolved.props).split(LT).join('\\u003C');
		return (
			LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + payload + LT + '/script' + GT
		);
	});
	// DEVTOOLS (server realm): emit ONE `server.region.rendered` per real <ogygia-region> this SSR pass
	// produces (inline/nested components ship no region, so they are skipped). Reads the already-computed
	// deriveds via untrack (no reactive dep); the whole block DCEs when devtools is off. Rides the page
	// side-channel the handle injects — so a region's server render lands in the same client-side stream
	// as its wake, keyed by the SAME data-og-fp.
	if (DEVTOOLS && typeof window === 'undefined') {
		untrack(() => {
			try {
				if (is_island && !island_inline) {
					record_server_event({
						domain: 'server',
						name: 'server.region.rendered',
						fp: island_fp || '',
						mode: 'island',
						entry: island_module_url || undefined,
						propsBytes: island_payload.length
					});
					if (island_skip)
						record_server_event({ domain: 'server', name: 'server.delta.skip', fp: island_fp || '' });
				} else if (is_server && !nested) {
					record_server_event({
						domain: 'server',
						name: 'server.region.rendered',
						fp: '',
						mode: 'server',
						entry: server_region_entry || undefined,
						propsBytes: server_payload.length
					});
				} else if (is_lake && lake_inside) {
					record_server_event({
						domain: 'server',
						name: 'server.region.rendered',
						fp: '',
						mode: 'lake',
						entry: __entry || undefined
					});
				}
			} catch {
				/* devtools emit must never break a render */
			}
		});
	}
</script>

<!-- svelte:head must be top-level (not inside {#if}); non-island/server modes leave it empty. -->
<svelte:head>{@html head_html}</svelte:head>
{#if is_island}
	{@const Component = island_component}
	{#if island_inline}{#if Component}<Component {...island_props_ready}>{@render island_children?.()}</Component>{/if}{:else if island_skip}<ogygia-region
			entry={island_module_url}
			wake={hydrate_attr}
			margin={root_margin || undefined}
			data-ogygia-keep={__keep || undefined}
			data-og-fp={island_fp || undefined}
			data-og-skipped
		></ogygia-region>{@html island_props_script}{:else}<ogygia-region
			entry={island_module_url}
			wake={hydrate_attr}
			margin={root_margin || undefined}
			data-ogygia-keep={__keep || undefined}
			data-og-fp={island_fp || undefined}
		>{#if Component}<Component {...island_props_body} />{/if}</ogygia-region>{@html island_props_script}{/if}
{:else if is_server}
	{@const Component = __component}
	{#if nested}{#if Component}<Component {...__props} />{/if}{:else}<ogygia-region
			entry={server_region_entry}
			render="defer"
			when={__defer}
			wake={__hydrate || undefined}
			margin={__margin || undefined}
			hydrate-margin={__hydrateMargin || undefined}
			endpoint={server_endpoint}
		>{#if ogygiaFallback}{@render ogygiaFallback()}{/if}</ogygia-region>{@html server_props_script}{/if}
{:else if is_lake}
	{#if lake_inside}
		<ogygia-region
			entry={__entry}
			wake="none"
			remount={__remount}
			when={lake_swr ? __when : undefined}
			max-age={__maxAge != null ? String(__maxAge) : undefined}
			on-expire={__onExpire || undefined}
			margin={lake_swr && __margin ? __margin : undefined}
			endpoint={lake_endpoint || undefined}
		>
			<LakeBoundary>{@render children?.()}</LakeBoundary>
		</ogygia-region>
	{:else}
		{@render children?.()}
	{/if}
{:else if resolved?.kind === 'inline'}
	{@const Component = resolved.component}
	<Component {...resolved.props}>{#if children}{@render children()}{/if}</Component>
{:else if resolved?.kind === 'dual'}
	{@const Component = resolved.component}
	<Component {...resolved.props}>{#if children}{@render children()}{/if}</Component>
{:else if resolved?.html != null}
	<!-- placeholder (or legacy children) shows until the styled HTML paints (replaceChildren). -->
	<ogygia-region live {@attach apply_live}>{#if placeholder}{@render placeholder()}{:else if children}{@render children()}{/if}</ogygia-region>
{:else if resolved}
	{@const d = /** @type {import('./region.js').DeferredRegion} */ (resolved)}
	{#key identity(d)}
		<ogygia-region entry={d.module || ''} render="defer" when="load" wake={d.hydrate || undefined} hydrate-margin={d.hydrateMargin || undefined} endpoint={d.url}>{#if placeholder}{@render placeholder()}{:else if children}{@render children()}{/if}</ogygia-region>{@html held_props_script}
	{/key}
{:else if of}
	<!-- Promise `of` still in flight (first resolution) — the region owns the whole wait. -->
	{@render placeholder?.()}
{/if}
