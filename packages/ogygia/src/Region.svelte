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
	import { islandDeps } from 'virtual:ogygia/island-deps';
	import { makeRegionEndpoint, mintServerIsland } from 'virtual:ogygia/region-endpoint';
	import { asset } from '$app/paths';
	import { building } from '$app/environment';
	import { isNested, setNested, claimRuntimeEmit } from './context.js';
	import { TRANSPORT_WIRE_KEY, reduce_transportable } from './live-transport.js';
	import LakeBoundary from './LakeBoundary.svelte';

	/**
	 * Every prop is optional: a HELD usage passes only `of`, a PLACEMENT usage (the transform's
	 * wrappers) passes only the `__*` internals — so `<Region of={value} />` type-checks for consumers
	 * without the internal props.
	 * @type {{
	 *   of?: import('./region.js').RegionValue;
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
		// Held API: a `RegionValue` from `region()` (inline / dual / deferred).
		of,
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

	// A held interactive dual renders exactly like a placed island — same SSR-inline + self-hydrate —
	// so both feed the island branch. A held static dual (no schedule) renders bare, like inline.
	// These read fixed-per-instance props (`of`/`__mode` never change for a given wrapper), so reading
	// them once is intentional — not a missed reactive capture.
	// svelte-ignore state_referenced_locally
	const held_dual_island = !!(of && of.kind === 'dual' && of.hydrate);
	// svelte-ignore state_referenced_locally
	const is_island = __mode === 'island' || held_dual_island;
	// svelte-ignore state_referenced_locally
	const is_server = __mode === 'server';
	// svelte-ignore state_referenced_locally
	const is_lake = __mode === 'lake';

	// Nested rule (islands/server): a region inside an already-awake region hydrates with its parent,
	// so it degrades to a plain inline render. Read once at init (a wrapper's mode is fixed per usage).
	const nested = isNested();
	if ((is_island || is_server) && !nested) setNested();
	if (nested && (is_island || is_server) && import.meta.env && import.meta.env.DEV) {
		const entry = untrack(() => (is_server ? __entry : island_entry));
		console.warn(
			is_server
				? `[ogygia] nested server island "${entry}" is inside another island; rendering it inline as a normal component ('server' strategy ignored).`
				: `[ogygia] nested island "${entry}" is inside another island; it hydrates with its parent (strategy ignored).`
		);
	}

	/** @param {unknown} value @param {string} entry */
	function stringify_props(value, entry) {
		try {
			return stringify(value, { [TRANSPORT_WIRE_KEY]: reduce_transportable });
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
	// Normalized island inputs, from placement props OR a held dual.
	const island_entry = $derived(
		held_dual_island ? of.module : __mode === 'island' ? __entry : ''
	);
	const island_component = $derived(held_dual_island ? of.component : __component);
	const island_props = $derived(held_dual_island ? of.props : __props);
	const island_children = $derived(held_dual_island ? children : children);
	// The `wake` value IS the strategy: 'load' | 'idle' | 'visible' | 'interaction' | a media query.
	const hydrate_attr = $derived(
		held_dual_island
			? of.hydrate
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
		held_dual_island
			? of.hydrateMargin || undefined
			: typeof visible === 'string'
				? visible
				: undefined
	);

	const island_module_url = $derived(
		nested || !island_entry ? '' : island_entry.startsWith('/@') ? island_entry : asset(island_entry)
	);

	const island_payload = $derived(
		nested ? '' : stringify_props(island_props, island_entry).split(LT).join('\\u003C')
	);
	const island_props_script = $derived(
		LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + island_payload + LT + '/script' + GT
	);

	// `wake: 'load'` — modulepreload facade + dep chunks in <head> so discovery is early.
	const island_preload = $derived.by(() => {
		if (nested || !is_island || hydrate_attr !== 'load' || !island_module_url) return '';
		const hrefs = [island_module_url];
		for (const dep of islandDeps(island_entry)) {
			const href = dep.startsWith('/@') ? dep : asset(dep);
			if (href && !hrefs.includes(href)) hrefs.push(href);
		}
		let html = '';
		for (const href of hrefs) html += LT + 'link rel="modulepreload" href="' + href + '"' + GT;
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

	// DOM `entry`: importable module URL when a deferred island wakes after swap; opaque id otherwise.
	const server_region_entry = $derived(
		nested ? '' : __module ? (__module.startsWith('/@') ? __module : asset(__module)) : __entry
	);

	const server_payload = $derived(
		nested || !__hydrate ? '' : stringify_props(__props, __entry).split(LT).join('\\u003C')
	);
	const server_props_script = $derived(
		server_payload
			? LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + server_payload + LT + '/script' + GT
			: ''
	);

	const server_wants_modulepreload = $derived(
		!!__module && !!__hydrate && (__hydrate === 'load' || __hydrate === __defer)
	);
	const server_modulepreload = $derived.by(() => {
		if (nested || !server_wants_modulepreload || !server_region_entry) return '';
		const hrefs = [server_region_entry];
		for (const dep of islandDeps(__module)) {
			const href = dep.startsWith('/@') ? dep : asset(dep);
			if (href && !hrefs.includes(href)) hrefs.push(href);
		}
		let html = '';
		for (const href of hrefs) html += LT + 'link rel="modulepreload" href="' + href + '"' + GT;
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
	// Runtime fallback when no <OgygiaRouter/> claimed the slot. Claim once, only for a top-level
	// island/server placement (lakes render inside an island; held regions rely on an existing runtime).
	const runtime_script =
		!nested && (is_island || is_server) && claimRuntimeEmit()
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
	const head_html = $derived(
		is_island ? runtime_script + island_preload : is_server ? runtime_script + server_preload : ''
	);

	// ────────────────────────────────────────────────────── held: live / deferred ──
	const stringify_devalue = stringify;
	/** @param {Element & { applyLive?: (v: unknown) => void }} node */
	function apply_live(node) {
		const f = of;
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
		if (!of || of.kind !== 'deferred' || !of.hydrate || !of.url) return '';
		const payload = stringify_devalue(of.props).split(LT).join('\\u003C');
		return (
			LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + payload + LT + '/script' + GT
		);
	});
</script>

<!-- svelte:head must be top-level (not inside {#if}); non-island/server modes leave it empty. -->
<svelte:head>{@html head_html}</svelte:head>
{#if is_island}
	{@const Component = island_component}
	{#if nested}{#if Component}<Component {...island_props}>{@render island_children?.()}</Component>{/if}{:else}<ogygia-region
			entry={island_module_url}
			wake={hydrate_attr}
			margin={root_margin || undefined}
			data-ogygia-keep={__keep || undefined}
		>{#if Component}<Component {...island_props}>{@render island_children?.()}</Component>{/if}</ogygia-region>{@html island_props_script}{/if}
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
{:else if of?.kind === 'inline'}
	{@const Component = of.component}
	<Component {...of.props}>{#if children}{@render children()}{/if}</Component>
{:else if of?.kind === 'dual'}
	{@const Component = of.component}
	<Component {...of.props}>{#if children}{@render children()}{/if}</Component>
{:else if of?.html != null}
	<ogygia-region live {@attach apply_live}>{#if children}{@render children()}{/if}</ogygia-region>
{:else}
	{@const d = /** @type {import('./region.js').DeferredRegion} */ (of)}
	{#key identity(d)}
		<ogygia-region entry={d.module || d.id} render="defer" when="load" wake={d.hydrate || undefined} hydrate-margin={d.hydrateMargin || undefined} endpoint={d.url}>{#if children}{@render children()}{/if}</ogygia-region>{@html held_props_script}
	{/key}
{/if}
