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
	import { untrack, getContext, setContext, createRawSnippet } from 'svelte';
	import { KIT_REQUEST_CONTEXT, kit_request_event } from './server/kit-context.js';
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import hmrUrl from 'virtual:ogygia/dev-hmr-url';
	import { islandDeps, islandCss, contentCss, islandReadsPage, islandPageKeys, islandRemotes, preloadPolicy } from 'virtual:ogygia/island-deps';
	import { makeRegionEndpoint, mintServerIsland, known_region_fps, islandFingerprint } from 'virtual:ogygia/region-endpoint';
	import { fingerprint_of } from './runtime/hash.js';
	import { asset } from '$app/paths';
	import { building } from '$app/environment';
	import { page } from '$app/state';
	import { record_page } from './page-seed-registry.js';
	import { document_tail, modulepreload_tag } from './server/document-tail.js';
	import { plan_props_wire, props_sidecar } from './server/props-wire.js';
	import { region_css_tag } from './server/region-css.js';
	import { isNested, setNested, isInLake, setHoleInline, documentIsCsrTrue, claimRuntimeEmit, claim_region_css, claim_kit_island } from './context.js';
	import { prepare_region_props, slot_pointer, slot_marker_open, SLOT_MARKER_CLOSE, next_slot_id } from './region-snippet.js';
	import { isRegion } from './region.js';
	import { register_late_region } from './late-region-registry.js';
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
	 *   __load?: () => Promise<import('svelte').Component>;
	 *   __props?: Record<string, unknown>; __defer?: string; __margin?: string; __hydrate?: string;
	 *   __hydrateMargin?: string; __module?: string; __cacheTtl?: number; __stitch?: string; __prefetch?: string;
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
		// The client wrapper's on-demand component fetch (its lazy module answered `undefined`: a
		// Kit document that did not render this island). See `late_component`.
		__load,
		__props,
		// server
		__defer = 'load',
		__margin,
		__hydrate,
		__hydrateMargin,
		__module = '',
		// Response cache max-age in seconds for this deferred hole (absent/0 → no-store). Signed at mint.
		__cacheTtl,
		// Stitching mark: `'serve'` (the freeze serve path fills the hole at origin, per visitor,
		// fail-open) or `'edge'` (the freeze capture rewrites it into an ESI include the CDN
		// fills — the shell stays edge-cached). Emitted as the hole's `stitch` attribute.
		__stitch = '',
		// Warm schedule for a deferred hole (`prefetch` attribute): the runtime fills the frame store
		// on it, ahead of `__defer` (the swap). Absent → the hole fetches on `__defer` only.
		__prefetch = '',
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
	/** Context mark: "this subtree renders inside Kit's own page pass" (see `kit_page_pass`). */
	const KIT_PAGE_PASS = Symbol.for('ogygia.kit-page-pass');

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
	// LATE REGION (streamed documents): with the server recorder armed (the handle's ALS), a
	// promise `of` registers for completion-order delivery DOWN THIS RESPONSE — the placeholder
	// wraps in an `og-late-slot` the boot swaps when the promise's baked chunk parses. Unarmed
	// (client, standalone, non-streaming context) → null → today's placeholder behavior.
	// svelte-ignore state_referenced_locally
	const late_slot =
		of_is_promise && typeof window === 'undefined'
			? register_late_region(/** @type {Promise<unknown>} */ (of))
			: null;
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

	// Nested rule (islands/server): a region inside an already-awake region hydrates with its parent,
	// so it degrades to a plain inline render. Read once at init (a wrapper's mode is fixed per usage).
	const nested = isNested();

	// `requestEvent()` inside a region rendered by Kit's OWN page pass: Kit's `__request__` context
	// carries `{ page }` only (ogygia's render roots add `event` themselves). Re-set the same key
	// for this region's subtree with the live event, so a component inside any island / lake /
	// server island reads the request the same way wherever it renders. Server only, once per
	// region, and only when no ancestor already did.
	//
	// The same fact — `{ page }` with no `event` — is what tells a KIT PAGE PASS apart from every
	// other render root (a hole endpoint, a baked held region, a router document, a late region):
	// only in Kit's own pass does the whole document flow through the handle's `transformPageChunk`,
	// so only there can an island's props sidecar be deferred to the end of the body. The outermost
	// region stamps the fact into context for its subtree (its own re-set of the request context
	// hides the bare `{ page }` from nested regions).
	let kit_page_pass = false;
	if (typeof window === 'undefined') {
		const req = /** @type {{ page?: unknown; event?: unknown } | undefined} */ (getContext(KIT_REQUEST_CONTEXT));
		kit_page_pass = getContext(KIT_PAGE_PASS) === true || !!(req && req.event == null);
		if (kit_page_pass && getContext(KIT_PAGE_PASS) !== true) setContext(KIT_PAGE_PASS, true);
		if (req && req.event == null) {
			const event = kit_request_event();
			if (event) setContext(KIT_REQUEST_CONTEXT, { ...req, event });
		}
	}
	// THE DOCUMENT TAIL (server/document-tail.ts) for this render — non-null only inside Kit's page
	// pass with a request tail installed. What the hints, the props sidecar and the seed-relative
	// props codec all key on (see each site below).
	const tail = typeof window === 'undefined' && kit_page_pass ? document_tail() : null;
	// csr=true rule (ISLANDS only): on a Kit-hydrated page an interactive region should render its
	// component INLINE in the Kit tree — no `<ogygia-region>`, no runtime — because Kit already
	// hydrates it. Same degradation as `nested`, gated by the csr context the transform injects into
	// csr=true route hosts. Server/deferred + lake regions are SERVER-DRIVEN UI, orthogonal to a
	// page's csr, so they are deliberately NOT degraded here (they keep their endpoint + runtime).
	// Does Kit hydrate this WHOLE document? (the leaf page's effective csr — the one fact that decides
	// it.) If so, every island degrades to a plain inline component on both legs: no `<ogygia-region>`,
	// no runtime claim, no FOUC. Server reads the build-time csr=true route map; client reads Kit's
	// bootstrap. Identical both legs, so the inline/island choice can never desync at hydrate.
	// INSIDE A LAKE the answer is always false: under Kit hydration a lake is adopted as opaque DOM
	// (the lake branch below), so Kit never reaches the regions authored inside it — they stay real
	// `<ogygia-region>`s on every page and the runtime wakes them. Server-side in practice (a lake's
	// inside is never rendered on the client); the runtime mirrors it with `inside_frozen`.
	// AN ERROR RENDER (`page.error` set — Kit sets it only when rendering `+error.svelte`; a form
	// action's `fail(400)` renders the page itself, status ≥ 400 and error null) is Kit's LAYOUT-branch
	// decision: the page node — and its `csr = false` — is dropped, so a 404 under a client-off page is
	// hydrated whenever the layouts say so. The server map has a twin for exactly that.
	function page_error_render() {
		try {
			return page.error != null;
		} catch {
			return false; // isolated render without a live page (a hole endpoint, a remote's region)
		}
	}
	const is_csr = documentIsCsrTrue(page_error_render()) && !isInLake();
	// The island branch renders inline when nested OR on a csr=true page.
	const island_inline = nested || is_csr;
	if ((is_island || is_server) && !nested) setNested();
	// A server island nested in an island renders its component INLINE (deferred ignored): mark the
	// subtree so a `keepFallback()` inside it fails with the reason instead of Kit's 500 page.
	if (is_server && nested) setHoleInline();

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
	// An inline island whose wrapper Kit CREATED on the client (a client-side navigation mounted it:
	// no SSR, so no rendered stamp, so its lazy module answered `undefined`) has no component yet.
	// Fetch it through `__load` and render when it lands — a client render, nothing to mismatch.
	// Never on the server (the SSR wrapper imports the entry) and never at hydration (a stamped
	// island arrives with its component in hand).
	/** @type {import('svelte').Component | undefined} */
	let late_component = $state(undefined);
	// svelte-ignore state_referenced_locally
	if (typeof window !== 'undefined' && island_inline && !__component && __load)
		__load().then((c) => {
			late_component = c;
		});
	const island_props = $derived(as_dual ? as_dual.props : __props);
	const island_children = $derived(children);

	// Capture the page snapshot for the island seed. On SSR this reads Kit's REAL `$app/state` page —
	// the only place the resolved load `data` is reachable (Kit merges it locally in render.js, never
	// on RequestState, and reading page in a hook throws). The handle records it into the
	// `application/ogygia-page` seed, so a hydrated island's `$page.data` / `.form` / `.error` /
	// `.status` are populated (boundary law: page.data crosses). No-op on the client (recorder unset;
	// the client `page` is already the shim seed), and a harmless no-op in an isolated server-island
	// endpoint render (no recorder installed there either). `untrack` — one snapshot read, no dep.
	//
	// THE SEED SHIPS ONLY FOR A REGION WHOSE CLIENT CODE READS IT: `islandReadsPage(entry)` is the
	// build's answer (the `$app/state` / `$app/stores` shim in the entry's chunk closure; fail-open for
	// an entry the handoff does not know, and in dev). The snapshot is recorded either way — the
	// handle also reads it for the freeze verdict and for server-side page reads — with `seed:false`
	// when this region has no reader. A page whose islands take everything as props asks for no
	// seed, and the handle then ships none: the whole `page.data` (hundreds of KB on a CMS page)
	// neither serialized nor downloaded twice. A nested region hydrates with its parent, whose
	// closure already includes it; a promise `of` resolves later with a module SSR cannot see, so it
	// asks (fail-open).
	//
	// THE REMOTE SEED SHIPS ONLY FOR REMOTES SOME REGION'S CLIENT CAN CALL: `islandRemotes(entry)` is
	// the build's list for this entry (the remote modules in its chunk closure). A region with no
	// client entry (a lake, a static hole, an inline held value) records `[]`; the fail-open cases
	// above record `null` ("may call anything"). The handle unions the records and seeds an
	// SSR-resolved remote only when it is in that union — a lake or a page script awaiting a query
	// no island imports (a whole CMS footer entry, measured 12.5 KB) no longer ships it as seed.
	if (typeof window === 'undefined') {
		untrack(() => {
			const entry = nested
				? ''
				: is_island
					? island_entry
					: is_server
						? __hydrate
							? __module
							: ''
						: of_is_promise
							? '?'
							: of_init && of_init.kind === 'deferred'
								? of_init.module
								: '';
			// SEED SHAPING: not a flag but an ask — which `page.data` keys this region's client reads
			// (`islandPageKeys`, the build's AST answer over the chunk closure), `'all'` when the build
			// could not pin them or does not know the entry, `false` when nothing in it reads the page.
			const seed = !entry
				? false
				: entry === '?' || !islandReadsPage(entry)
					? entry === '?'
						? 'all'
						: false
					: (islandPageKeys(entry) ?? 'all');
			const remotes = !entry ? [] : entry === '?' ? null : islandRemotes(entry);
			try {
				record_page(
					{ data: page.data, form: page.form, error: page.error, status: page.status },
					seed,
					remotes
				);
			} catch {
				/* isolated render without a live page — the recorder is unset there anyway */
			}
		});
	}

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
	// The SAME reset wraps a server island's `ogygiaFallback` (markup below): the fallback is the
	// PAGE's markup rendered inside the hole's shell, not the island's tree — an island in it (a login
	// dropdown inside an actions hole) must be a full region, or a `keepFallback()`-kept fallback
	// would stand forever with a dead, flattened component inside it (e2e/lake-kit.spec.ts).
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

	// THE WIRE PLAN (server/props-wire.ts): one walk of this island's props picks its lane (plain
	// JSON, or devalue for anything devalue exists for) and yields the CANONICAL, seed-independent
	// text the fingerprint hashes. The sidecar's final text is produced later, when the document
	// tail renders — by then the request knows whether the page seed ships, and a props subtree
	// that is a seed node crosses as a reference (seed-refs.ts), whichever island rendered first.
	const island_wire = $derived(
		nested || !is_island || island_inline ? null : plan_props_wire(island_props_wire, island_entry)
	);
	// THE ISLAND'S FINGERPRINT (server/fingerprint.ts, through the client-stubbed virtual): its
	// module URL + canonical props text, a native digest. Emitted as data-og-fp; the client only ever
	// READS it (the reconciler's key, the sidecar id, the `x-ogygia-known` set it sends back on nav
	// so the server can skip re-rendering an unchanged island). A function of the props alone: the
	// same props give the same fingerprint with or without the seed.
	const island_fp = $derived(island_wire ? islandFingerprint(island_module_url, island_wire.canonical) : '');
	// SERVER-DELTA (D3): SKIP rendering a NON-cached island the client already has live (its fp is
	// in the SPA nav's x-ogygia-known set). Emit the region's identifying attrs + props script but NO
	// component content — the reconciler keeps the live node (same data-key). Safe: known_region_fps()
	// is empty on a full load / non-SPA request, so this never fires except on an SPA nav.
	const island_skip = $derived(
		is_island && !island_inline && !has_slot_children && (__cacheTtl ?? 0) <= 0 && !!island_fp
			&& known_region_fps().has(island_fp)
	);
	// THE DOCUMENT TAIL (server/document-tail.ts): in Kit's page pass this region's module-preload
	// hints and its props sidecar go to the end of the body — the handle emits the tail once, after
	// the content, before the seeds — so the CSS and the hero are requested before a single island
	// byte moves (480 KB of props and 1.7 MB of hinted chunks sat above the LCP image on one measured
	// page). Any other render root has no tail (`document_tail()` → null): a hole response, a baked
	// ticket, a router document keep their hints in the head and their sidecar adjacent, so the HTML
	// stays self-contained wherever it is spliced. Decided once at init — the SSR pass renders each
	// region exactly once.
	const island_props_tail =
		!!tail &&
		untrack(() => {
			const wire = island_wire;
			const fp = island_fp;
			if (!wire || !fp) return false;
			// The sidecar is KEYED by the fingerprint (`data-ogygia-props` + `id`), so the runtime
			// finds it wherever it sits — adjacent, or at the end of the body (runtime/sidecar.ts).
			tail.props(fp, (seed) => props_sidecar(fp, wire.wire(seed)));
			return true;
		});
	// Adjacent sidecar (no tail: a hole response, a baked ticket, a router document, a test render):
	// self-contained, never seed-relative.
	const island_props_inline = $derived(
		island_props_tail || !island_wire ? '' : props_sidecar(island_fp, island_wire.wire(null))
	);

	// `wake: 'load'` — modulepreload facade + dep chunks in <head> so discovery is early.
	// `wake: 'visible'` / `wake: 'interaction'` (under `preload: 'all'`) — the SAME hints. All of
	// them ride at `fetchpriority="low"`: the bytes never contend with critical work, the module map
	// is warm, and the later `import()` (visible's idle warm, interaction's hover warm, or the real
	// wake) is a pure cache hit — modulepreload compiles into the module map with module CORS
	// semantics, never a double fetch. Execution still waits for the schedule; only bytes move early.
	// Only SSR can do this: the client knows just the facade URL; the dep closure lives in the
	// islandDeps manifest. Browsers without fetchpriority ignore the attribute (normal priority).
	// Media-query wakes stay unhinted — the server can't know the viewport, so downloading would be
	// a blind bet.
	// `ogygia({ regions: { preload } })` — 'load' (the default) hints only load-woken islands: a
	// `visible` island fetches when it intersects (its margin is the lead time), `interaction` on
	// the hover/focus/touch warm-up, so no bytes move before there is a reason to. 'all' restores
	// the background hints for every island; 'none' hints nothing (a load island fetches on import).
	// The hrefs to hint, in order; the tail takes them as they are, the head gets them as tags.
	const island_preload_hrefs = $derived.by(() => {
		// Inline on a csr=true document too: the client wrapper imports the entry lazily there (Kit's
		// static graph no longer reaches it), so the hint is what keeps the wake off the critical path.
		if (nested || !is_island || !island_module_url) return [];
		if (preloadPolicy === 'none') return [];
		if (hydrate_attr !== 'load' && hydrate_attr !== 'visible' && hydrate_attr !== 'interaction')
			return [];
		if (preloadPolicy !== 'all' && hydrate_attr !== 'load') return [];
		// EVERY hint is `fetchpriority="low"`, the `load` island's included. A hint's job is discovery
		// (no parse-then-import waterfall), not priority: nothing an island downloads is needed for
		// first paint — the server painted the content — so island code must never outrank the CSS
		// and the LCP image. At normal priority a header island with a 1.7 MB closure pushed a 79 KB
		// hero from 1 s to 5 s on a 1.6 Mbps line; at low the chunk still lands before the runtime
		// (which waits for the document to parse) asks for it on any normal line. There is no other
		// priority anywhere: the head dedupe and the runtime's hint lookup know only "hinted or not".
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
		// The wire plan found each descriptor's public entry URL in the payload (props-wire.ts).
		for (const m of island_wire?.live_entries ?? []) add_with_deps(m, m);
		return hrefs;
	});
	// Hints ride the document tail on a Kit page (see `tail` above); in the head everywhere else.
	const island_preload_tail =
		!!tail &&
		untrack(() => {
			const hrefs = island_preload_hrefs;
			if (!hrefs.length) return false;
			tail.hints(hrefs);
			return true;
		});
	const island_preload_head = $derived(
		island_preload_tail ? '' : island_preload_hrefs.map(modulepreload_tag).join('')
	);

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

	// A hydrating hole's props: ADJACENT and self-contained (the hole's HTML is spliced by the
	// runtime), unkeyed, in whichever lane the props qualify for (props-wire.ts).
	const server_wire = $derived(nested || !__hydrate ? null : plan_props_wire(__props, __entry));
	const server_props_script = $derived(server_wire ? props_sidecar('', server_wire.wire(null)) : '');
	// The hole's IDENTITY — the fingerprint of its region id + canonical props, the same function on
	// both legs (runtime/hash.ts), so the client leg computes the SAME value the server emitted. The
	// runtime keys the server-minted facts (endpoint, props sidecar) on it: when Kit gives up
	// hydrating a client-on document and mounts it fresh, the client leg renders this hole again
	// with NO address (it cannot mint), and the runtime hands the SSR facts back by identity — never
	// by position. Emitted on every top-level hole; costs one walk of the hole's (small) props.
	const server_identity = $derived(
		nested || !is_server ? '' : fingerprint_of(__entry, '', (server_wire ?? plan_props_wire(__props || {}, __entry)).canonical)
	);
	// On a KIT-HYDRATED document the facts ride the document tail too (server/document-tail.ts
	// `hole()`): Kit's root can be cleared and mounted fresh, the tail outside it cannot. A csr=false
	// document has no Kit client to rebuild it, so nothing is recorded there. Decided once at init —
	// the SSR pass renders each region exactly once.
	if (tail && is_csr && is_server && !nested) {
		untrack(() => {
			const endpoint = server_endpoint;
			if (endpoint) tail.hole(server_identity, endpoint, server_props_script);
		});
	}

	const server_wants_modulepreload = $derived(
		!!__module &&
			!!__hydrate &&
			(__hydrate === 'load' ||
				__hydrate === __defer ||
				__hydrate === 'visible' ||
				__hydrate === 'interaction')
	);
	const server_modulepreload_hrefs = $derived.by(() => {
		if (nested || !server_wants_modulepreload || !server_region_entry) return [];
		if (preloadPolicy === 'none') return [];
		// Same low-priority background hints as `island_preload_hrefs` for a phase-2 `visible`/
		// `interaction` hydrate — and the same `regions.preload` policy: under 'load' only a phase-2
		// that wakes as soon as the HTML lands (`load`, or matching the fetch schedule) is hinted.
		const background =
			(__hydrate === 'visible' || __hydrate === 'interaction') && __hydrate !== __defer;
		if (background && preloadPolicy !== 'all') return [];
		// Low for every hint — see `island_preload_hrefs`.
		const hrefs = [server_region_entry];
		for (const dep of islandDeps(__module)) {
			const href = asset(dep);
			if (href && !hrefs.includes(href)) hrefs.push(href);
		}
		return hrefs;
	});
	const server_fetch_preload = $derived.by(() => {
		// Only `defer: 'load'`: start the endpoint fetch during HTML parse (warms the per-hole load).
		if (nested || building || __defer !== 'load' || !server_endpoint) return '';
		const href_attr = server_endpoint.split('&').join('&amp;');
		return LT + 'link rel="preload" as="fetch" crossorigin="anonymous" href="' + href_attr + '"' + GT;
	});
	// The fetch preload STAYS in the head: it starts the hole's content request during the HTML parse
	// (content, not island code). Only the module hints ride the tail.
	const server_modulepreload_tail =
		!!tail &&
		untrack(() => {
			const hrefs = server_modulepreload_hrefs;
			if (!hrefs.length) return false;
			tail.hints(hrefs);
			return true;
		});
	const server_preload = $derived(
		server_fetch_preload +
			(server_modulepreload_tail ? '' : server_modulepreload_hrefs.map(modulepreload_tag).join(''))
	);

	// ───────────────────────────────────────────────────────────── lake branch ──
	// Lakes matter only inside an island (freeze + lift/restore). In the shell they render bare.
	const lake_inside = is_lake && nested;
	const lake_swr = $derived(__remount === 'swr');
	const lake_endpoint = $derived(
		lake_inside && lake_swr ? makeRegionEndpoint(__entry || '', __props || {}) : ''
	);
	// A lake on a KIT-HYDRATED document (a csr=true page). Kit's client hydrates this wrapper too,
	// but the lake's component is the render-nothing placeholder on the client (its JS ships to no
	// browser), so a normal template here would MISMATCH — Svelte then discards the SSR DOM and
	// re-renders, and the lake vanishes (found on a site header under a csr=true page). Instead the
	// lake renders through ONE snippet whose SERVER form emits exactly one element (the frozen region
	// with the lake's HTML inside) and whose CLIENT form is a raw snippet: hydration ADOPTS the
	// element at the render position verbatim — no diff, no mismatch, the server HTML stays. (The same
	// adoption an island's slot children get.) It is a real frozen region: LakeBoundary resets
	// `nested` and marks the lake's inside, so the islands and holes authored in there emit their
	// real regions and wake on the runtime, which Kit never touches.
	const lake_attrs = $derived.by(() => {
		const esc = (v) =>
			String(v).split('&').join('&amp;').split('"').join('&quot;').split(LT).join('&lt;');
		let s = ' entry="' + esc(__entry || '') + '" wake="none" remount="' + esc(__remount) + '"';
		if (lake_swr) s += ' when="' + esc(__when) + '"';
		if (__maxAge != null) s += ' max-age="' + esc(String(__maxAge)) + '"';
		if (__onExpire) s += ' on-expire="' + esc(__onExpire) + '"';
		if (lake_swr && __margin) s += ' margin="' + esc(__margin) + '"';
		if (lake_endpoint) s += ' endpoint="' + esc(lake_endpoint) + '"';
		return s;
	});
	const lake_adopt =
		typeof window === 'undefined'
			? // SERVER: a server-convention snippet (`(renderer) => …`) — one element, the lake inside.
				/** @param {{ push(html: string): void }} renderer */
				(renderer) => {
					renderer.push(LT + 'ogygia-region' + lake_attrs + GT);
					LakeBoundary(/** @type {never} */ (renderer), /** @type {never} */ ({ children }));
					renderer.push(LT + '/ogygia-region' + GT);
				}
			: createRawSnippet(() => ({
					render: () => LT + 'ogygia-region' + lake_attrs + GT + LT + '/ogygia-region' + GT,
					/** @param {Element} el */
					setup: (el) => {
						// Created fresh on the client (a Kit client-side navigation mounted this lake, or Kit
						// gave up hydrating the document and mounted fresh), so there was no SSR element to
						// adopt: a lake is server HTML, and there is none here. The runtime repaints it from
						// the copy it took of the SSR children when the lake first connected (lakes.ts), if
						// this document had them; a route Kit client-renders from scratch has nothing.
						if (!el.firstChild && import.meta.env && import.meta.env.DEV)
							console.warn(
								`[ogygia] lake "${__entry}" was mounted by Kit on the client with no server HTML to adopt (a client-side navigation, or a hydration failure — look for an error above). The runtime restores it from its server HTML when this document rendered it; otherwise it stays empty. A lake is server HTML: keep chrome lakes in a layout that persists across navigations, or serve that route csr=false.`
							);
					}
				}));

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
			html += region_css_tag(href, asset(href));
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
		// A csr=true document's inline island links its CSS here as well: the client wrapper imports
		// the component lazily there, so Kit's route stylesheets no longer carry it (that static
		// reach is what linked every registry block's sheet on every page). Nested stays out — its
		// CSS rides the parent island's closure.
		if (nested || __mode !== 'island' || !island_entry) return '';
		let html = '';
		for (const href of claim_region_css(islandCss(island_entry)))
			html += region_css_tag(href, asset(href));
		return html;
	});
	// The RENDERED stamp for an inline island (a csr=true document, or nested in a woken island):
	// `<meta name="ogygia-kit-island" content="<entry>">`, once per entry per request. The client
	// wrapper's lazy component module (emit.ts `lazy_entry_source`) reads it before Kit hydrates and
	// imports the entry only for stamped islands — an unrendered registry block ships nothing.
	const kit_island_meta = $derived.by(() => {
		if (!is_island || !island_inline || !island_entry || !claim_kit_island(island_entry)) return '';
		const content = String(island_entry).split('&').join('&amp;').split('"').join('&quot;');
		return LT + 'meta name="ogygia-kit-island" content="' + content + '"' + GT;
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
			html += region_css_tag(href, asset(href));
		return html;
	});

	const head_html = $derived(
		(is_island
			? runtime_script + island_preload_head + island_css_html + kit_island_meta
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
		// devalue output is `<`-safe by itself; adjacent and unkeyed, like a hole's.
		return props_sidecar('', { text: stringify_devalue(resolved.props), json: false });
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
						propsBytes: island_wire?.canonical.length ?? 0
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
						propsBytes: server_wire?.canonical.length ?? 0
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
	{@const Component = island_component ?? late_component}
	{#if island_inline}{#if Component}<Component {...island_props_ready}>{@render island_children?.()}</Component>{/if}{:else if island_skip}<ogygia-region
			entry={island_module_url}
			wake={hydrate_attr}
			margin={root_margin || undefined}
			data-ogygia-keep={__keep || undefined}
			data-og-fp={island_fp || undefined}
			data-og-skipped
		></ogygia-region>{@html island_props_inline}{:else}<ogygia-region
			entry={island_module_url}
			wake={hydrate_attr}
			margin={root_margin || undefined}
			data-ogygia-keep={__keep || undefined}
			data-og-fp={island_fp || undefined}
		>{#if Component}<Component {...island_props_body} />{/if}</ogygia-region>{@html island_props_inline}{/if}
{:else if is_server}
	{@const Component = __component}
	{#if nested}{#if Component}<Component {...__props} />{/if}{:else}<ogygia-region
			entry={server_region_entry}
			render="defer"
			stitch={__stitch || undefined}
			prefetch={__prefetch || undefined}
			when={__defer}
			wake={__hydrate || undefined}
			margin={__margin || undefined}
			hydrate-margin={__hydrateMargin || undefined}
			endpoint={server_endpoint}
			data-og-hole={server_identity || undefined}
		>{#if ogygiaFallback}<SlotBoundary>{@render ogygiaFallback()}</SlotBoundary>{/if}</ogygia-region>{@html server_props_script}{/if}
{:else if is_lake}
	{#if is_csr}{@render lake_adopt()}{:else if lake_inside}
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
	<!-- Promise `of` still in flight (first resolution) — the region owns the whole wait. On a
	     STREAMED document the slot wrapper makes this hole late-chunk-addressable. -->
	{#if late_slot}<og-late-slot data-og-slot={late_slot} style="display:contents"
			>{@render placeholder?.()}</og-late-slot
		>{:else}{@render placeholder?.()}{/if}
{/if}
