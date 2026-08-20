/**
 * Region EMIT — codegen from a lowered descriptor to per-island virtual-module SOURCE. Pure leaves:
 * `descriptor → source string`, no state, no AST. The one shared set of emitters the `.svelte` host
 * and the `.ts` registry both call, so a `wake:` mark lowers to byte-identical artifacts from either
 * entry point:
 *   - the ENTRY  (`island_entry_source` / `region_entry_source`) — a JS re-export of the real component;
 *   - the WRAPPER (`island_wrapper_source`) — the mountable `.svelte` that renders `<ogygia-region>`;
 *   - the BINDING legs (`make_region_binding` / `wrapper_attach_binding` / `make_wake_island`) — the
 *     leg-split descriptor (SSR carries the signer + server render; client is metadata-only).
 */
import { regionBindingVirtualId } from '../ids.js';

/**
 * Source of the generated `__renderHtml(props)` for a binding's SSR leg. The returned HTML must be
 * self-sufficient when it crosses a wire, so it carries stylesheets THREE ways:
 * - the component's OWN `<link>`s (its island entry's CSS assets — the page never imported it);
 * - links NESTED regions emitted into `render().head` (a region rendered inside this render pass —
 *   props-composition, a recomposer's leaves — emits its `<link>`s via `svelte:head`, and keeping
 *   only `.body` would silently drop them: the leaf arrives unstyled);
 * - the body itself (which may contain nested self-describing `<ogygia-region>` island markup).
 */
function render_html_source(moduleUrl: string): string {
	return (
		`(props) => { const r = __ogRegionRender(__ogRegionComp, { props }); ` +
		`const own = __ogRegionCss(${JSON.stringify(moduleUrl)}).map((h) => ` +
		`'<link rel="stylesheet" href="' + h + '" data-ogygia-region-css>').join(''); ` +
		`const nested = (r.head.match(/<link\\b[^>]*data-ogygia-region-css[^>]*>/g) || []).join(''); ` +
		`return own + nested + r.body; }`
	);
}

/**
 * The component-import line for a generated module — a NAMED export (`import { Header as X } from
 * '@barrel'`, the asRegion/barrel escape hatch) or a plain default (`import X from './X.svelte'`, a
 * `.svelte` file or a package default). `exportName` is undefined/`'default'` for the default case.
 */
export function component_import_line(local: string, spec: string, exportName?: string): string {
	return exportName && exportName !== 'default'
		? `import { ${exportName} as ${local} } from ${JSON.stringify(spec)};`
		: `import ${local} from ${JSON.stringify(spec)};`;
}

/** JS re-export of the real component — the held region's entry (SSR render + client hydrate). */
function region_entry_source(componentPath: string, iid: string, exportName?: string) {
	return (
		component_import_line(`__OgygiaComp_${iid}`, componentPath, exportName) + '\n' +
		`export default __OgygiaComp_${iid};\n`
	);
}

/**
 * The island ENTRY module — a JS re-export of the real component, loaded on both client hydrate and
 * server render. The transportables import registers every `[ogygia.wire]` codec before props decode,
 * so an island receiving a transportable prop never needs to import the class itself. Shared by the
 * `.svelte` host and the `.ts` registry (a `wake:` mark) so a mountable binding is built the same way
 * from either.
 */
export function island_entry_source(componentPath: string, iid: string, exportName?: string): string {
	return (
		`import 'virtual:ogygia/transportables';\n` +
		component_import_line(`__OgygiaComp_${iid}`, componentPath, exportName) +
		'\n' +
		`export default __OgygiaComp_${iid};\n`
	);
}

/**
 * The island WRAPPER (`.svelte`) — a MOUNTABLE component that renders `<ogygia-region>` on its wake
 * schedule. Placing it (`<C/>`, `<svelte:component this={C}/>`) emits the shell; the island's JS is
 * fetched only when the shell wakes (e.g. `wake: 'visible'` → on scroll-into-view). Shared by the
 * `.svelte` host and the `.ts` registry. `entry_url` is the resolved client/dev module URL the caller
 * computes (ctx-dependent); `lang` is the `<script>` lang attribute (`''` for plain JS).
 */
export function island_wrapper_source(
	iid: string,
	componentPath: string,
	entryPath: string,
	strategy: string,
	options: Record<string, unknown> | undefined,
	exportName: string | undefined,
	entry_url: string,
	lang: string
): string {
	const strategy_attrs = strategy_to_attr(strategy, options);
	const persist_attr = options?.keep ? ` __keep={${JSON.stringify(options.keep)}}` : '';
	return (
		`<script${lang}>\n` +
		`\timport { Region as OgygiaRegion__Wrapper } from 'ogygia/internal';\n` +
		`\timport __OgygiaEntry from ${JSON.stringify(entryPath)};\n` +
		`\t${component_import_line('__OgygiaCss', componentPath, exportName)}\n` +
		`\tlet { children, ...__props } = $props();\n` +
		`</script>\n` +
		// `children` rides as an EXPLICIT prop, never as template children: wrapping `{@render
		// children?.()}` in the tags would hand Region a fragment snippet even for a CHILDLESS call
		// site — Region's `island_children != null` gate would then serialize a pointless empty slot.
		`<OgygiaRegion__Wrapper __mode="island" ${strategy_attrs}${persist_attr} __entry={${JSON.stringify(entry_url)}} ` +
		`__component={__OgygiaEntry} __css={__OgygiaCss} {__props} {children} />\n`
	);
}

/**
 * Build the held-region descriptor shared by the `.svelte` and `.ts` paths. It ALWAYS carries a
 * client chunk + `__module` (the region MIGHT be woken); when used statically the chunk is simply
 * never fetched (HTML only at runtime). Two marker flavors feed it:
 *   - `wake: 'x'`      → bakes `__hydrate: 'x'` — `region(C, props)` wakes on that schedule.
 *   - `region: 'raw'`  → bakes NO schedule — `region(C, props, { wake })` sets it at the call.
 * `region()` reads `opts.wake ?? binding.__hydrate`, so a baked schedule is the default and the call
 * can override. `kind` is always `'hydrate'` so the chunk is emitted; `server:true` — the endpoint
 * renders the HTML either way.
 */
export function make_region_binding(opts: {
	iid: string;
	componentPath: string;
	entryPath: string;
	hostPath: string;
	moduleUrl: string;
	/** baked wake schedule from a `wake:` mark; absent for `region: 'raw'` (schedule set at the call) */
	hydrate?: string;
	/** rootMargin baked when `hydrate` is `'visible'` */
	hydrateMargin?: string;
	/** named export to pull (asRegion/barrel); undefined → default import */
	exportName?: string;
	identity: string;
}) {
	// Descriptor metadata `region()` reads. `__hydrate` is baked only for a `wake:` mark; a
	// `region: 'raw'` binding bakes none and the schedule comes from the `region()` call's `{ wake }`.
	// The runtime `<ogygia-region>` fetches on mount (`when: 'load'`) and wakes on the resolved schedule.
	// Fetch timing is the consumer's own `{#if}` — a held region has no render axis.
	let meta = `__ogRegion: ${JSON.stringify(opts.iid)}, __module: ${JSON.stringify(opts.moduleUrl)}`;
	if (opts.hydrate) meta += `, __hydrate: ${JSON.stringify(opts.hydrate)}`;
	if (opts.hydrate && opts.hydrateMargin != null)
		meta += `, __hydrateMargin: ${JSON.stringify(opts.hydrateMargin)}`;
	return {
		id: opts.iid,
		virtualPath: opts.entryPath,
		source: region_entry_source(opts.componentPath, opts.iid, opts.exportName),
		bindingPath: regionBindingVirtualId(opts.iid),
		// SSR leg is DUAL-FACE: it carries the real component (so `region()` can render inline in
		// the same server pass) AND the signer (so the transport can mint a capability when the
		// held region crosses the wire). `__renderHtml` renders the component to HTML on the server when
		// the held region is awaited (live regions), so the ticket travels with its markup — no fetch.
		// `svelte/server` is imported only on this SSR leg; the client leg is metadata-only, so the
		// component and server render never ship to the browser bundle.
		bindingSsrSource:
			component_import_line('__ogRegionComp', opts.componentPath, opts.exportName) + '\n' +
			`import { makeRegionEndpoint as __ogRegionSign } from 'ogygia/internal/server';\n` +
			`import { render as __ogRegionRender } from 'svelte/server';\n` +
			// The page never imported this server-picked component, so its scoped CSS is on no page
			// stylesheet. Prefix the render with the island's `<link>`s (the client hoists them to
			// <head>). Resolved on the SSR leg only — the client binding stays metadata-only.
			`import { islandCss as __ogRegionCss } from 'virtual:ogygia/island-deps';\n` +
			`export default { ${meta}, __component: __ogRegionComp, __sign: __ogRegionSign, ` +
			`__renderHtml: ${render_html_source(opts.moduleUrl)} };\n`,
		bindingClientSource: `export default { ${meta} };\n`,
		hostPath: opts.hostPath,
		componentPath: opts.componentPath,
		server: true,
		kind: 'hydrate',
		held: true,
		lakes: [],
		identity: opts.identity
	};
}

/**
 * A `wake`-marked import is rewritten to a binding that is BOTH placeable and holdable: `<C/>` (or a
 * dynamic `<C/>` portable binding) renders the island wrapper, while `region(C)` reads a descriptor.
 * We get both from ONE binding by attaching the descriptor fields onto the wrapper component as own
 * properties — Svelte ignores them when rendering `<C/>`, and `region()` sees `__ogRegion` and reads
 * `__component`/`__sign`/`__hydrate`. The baked `__hydrate` is the mark's schedule; a `region()` call
 * can still override it. Leg-split like a held descriptor: the SSR leg carries the signer + server
 * render (server-only), the client leg is metadata. Returns `{ ssr, client }` module sources.
 */
function wrapper_attach_binding(opts: {
	iid: string;
	wrapperPath: string;
	componentPath: string;
	moduleUrl: string;
	hydrate: string;
	hydrateMargin?: string;
	/** named export to pull (asRegion/barrel); undefined → default import */
	exportName?: string;
}) {
	let meta = `__ogRegion: ${JSON.stringify(opts.iid)}, __module: ${JSON.stringify(opts.moduleUrl)}`;
	if (opts.hydrate) meta += `, __hydrate: ${JSON.stringify(opts.hydrate)}`;
	if (opts.hydrate && opts.hydrateMargin != null)
		meta += `, __hydrateMargin: ${JSON.stringify(opts.hydrateMargin)}`;
	return {
		ssr:
			`import __OgygiaWrap from ${JSON.stringify(opts.wrapperPath)};\n` +
			component_import_line('__ogRegionComp', opts.componentPath, opts.exportName) + '\n' +
			`import { makeRegionEndpoint as __ogRegionSign } from 'ogygia/internal/server';\n` +
			`import { render as __ogRegionRender } from 'svelte/server';\n` +
			`import { islandCss as __ogRegionCss } from 'virtual:ogygia/island-deps';\n` +
			`Object.assign(__OgygiaWrap, { ${meta}, __component: __ogRegionComp, __sign: __ogRegionSign, ` +
			`__renderHtml: ${render_html_source(opts.moduleUrl)} });\n` +
			`export default __OgygiaWrap;\n`,
		client:
			`import __OgygiaWrap from ${JSON.stringify(opts.wrapperPath)};\n` +
			`Object.assign(__OgygiaWrap, { ${meta} });\n` +
			`export default __OgygiaWrap;\n`
	};
}

/**
 * The complete island record for a `wake:` mark — the ONE emitter shared by the `.svelte` host (a
 * placed `import X with { wake }`) and the `.ts` registry (a `wake:` mark handed to a renderer). The
 * binding it produces is BOTH mountable (placing it, incl. via `<svelte:component>`, renders the
 * `<ogygia-region>` shell that fetches the island JS only on its schedule) AND holdable (the descriptor
 * fields ride on the wrapper, so `region(C)` still works). Threading both paths through here is what
 * keeps `.svelte` and `.ts` `wake:` byte-identical — a `.ts` `wake: 'visible'` is exactly a `.svelte`
 * `wake: 'visible'`. Callers own the host-specific import rewrite; this owns the record.
 * `moduleUrl` is the resolved client/dev module URL; `lang` is the wrapper `<script>` lang (`''` = JS).
 */
export function make_wake_island(opts: {
	iid: string;
	componentPath: string;
	entryPath: string;
	wrapperPath: string;
	moduleUrl: string;
	strategy: string;
	options?: Record<string, unknown>;
	exportName?: string;
	hostPath: string;
	identity: string;
	lang: string;
	/**
	 * A `.ts` registry / remote binding, which may be handed to `region()` and CROSS the wire (a live
	 * or remote region): it needs a server-manifest entry (`server`) so its endpoint can render it, and
	 * the `held` mark that pulls in the live/morph runtime. A `.svelte` placed island never crosses, so
	 * it stays `server:false`. Either way the binding is the SAME mountable wrapper — only the manifest
	 * flags differ, which is also why the two carry distinct identities (an endpoint vs none).
	 */
	held?: boolean;
}) {
	const margin = opts.strategy === 'visible' ? (opts.options?.margin as string | undefined) : undefined;
	const attach = wrapper_attach_binding({
		iid: opts.iid,
		wrapperPath: opts.wrapperPath,
		componentPath: opts.componentPath,
		moduleUrl: opts.moduleUrl,
		hydrate: opts.strategy,
		hydrateMargin: margin,
		exportName: opts.exportName
	});
	return {
		id: opts.iid,
		virtualPath: opts.entryPath,
		wrapperPath: opts.wrapperPath,
		wrapperSource: island_wrapper_source(
			opts.iid,
			opts.componentPath,
			opts.entryPath,
			opts.strategy,
			opts.options,
			opts.exportName,
			opts.moduleUrl,
			opts.lang
		),
		// The host imports THIS attach binding (placeable + holdable), not the bare wrapper.
		bindingPath: regionBindingVirtualId(opts.iid),
		bindingSsrSource: attach.ssr,
		bindingClientSource: attach.client,
		source: island_entry_source(opts.componentPath, opts.iid, opts.exportName),
		hostPath: opts.hostPath,
		componentPath: opts.componentPath,
		// A `.ts` held binding may cross the wire → it needs a server-manifest entry + the live/morph
		// mark. A `.svelte` placed island never crosses, so `server:false`, no `held`.
		server: !!opts.held,
		...(opts.held ? { held: true } : {}),
		kind: 'hydrate',
		lakes: [],
		identity: opts.identity,
		strategy: opts.strategy,
		keep: opts.options?.keep
	};
}

/**
 * The SERVER-island wrapper (`.svelte`) — `render: 'deferred'`: a hole whose HTML is fetched on the
 * `wake` schedule. `__defer` carries the fetch schedule; `__cacheTtl` (when signed) sets the hole's
 * response cache; a deferred island that ALSO hydrates carries `__hydrate` + `__module` (its client
 * entry URL). `module_url` is the resolved client/dev entry URL (used only when it hydrates); `lang`
 * is the wrapper `<script>` lang.
 */
export function server_wrapper_source(
	iid: string,
	componentPath: string,
	entryPath: string,
	options: Record<string, unknown> | undefined,
	exportName: string | undefined,
	module_url: string,
	lang: string
): string {
	const deferred_hydrate = !!options?.hydrate;
	const fetch_when = options?.when || 'load';
	let server_attrs = `__defer={${JSON.stringify(fetch_when)}}`;
	if (options?.margin != null) server_attrs += ` __margin={${JSON.stringify(options.margin)}}`;
	// Signed at mint into the hole's endpoint → the handle answers `private, max-age=cacheTtlSec`.
	if (options?.cacheTtlSec != null) server_attrs += ` __cacheTtl={${JSON.stringify(options.cacheTtlSec)}}`;
	if (deferred_hydrate) {
		server_attrs += ` __hydrate={${JSON.stringify(options.hydrate)}}`;
		server_attrs += ` __module={${JSON.stringify(module_url)}}`;
		if (options.hydrateMargin != null) {
			server_attrs += ` __hydrateMargin={${JSON.stringify(options.hydrateMargin)}}`;
		}
	}
	return (
		`<script${lang}>\n` +
		`\timport { Region as OgygiaRegion__Wrapper } from 'ogygia/internal';\n` +
		`\timport __OgygiaEntry from ${JSON.stringify(entryPath)};\n` +
		`\t${component_import_line('__OgygiaCss', componentPath, exportName)}\n` +
		`\tlet { ogygiaFallback, ...__props } = $props();\n` +
		`</script>\n` +
		`<OgygiaRegion__Wrapper __mode="server" __entry={${JSON.stringify(iid)}} __component={__OgygiaEntry} ` +
		`__css={__OgygiaCss} {__props} ${server_attrs} {ogygiaFallback} />\n`
	);
}

/**
 * The LAKE wrapper (`.svelte`) — `render: page, wake: none`: a frozen region inside a hydrated island.
 * A `swr` lake carries an endpoint (`__when` + `__props`) to remount on its schedule; `cache`/`empty`
 * are wrapper-only. Static `<OgygiaLakeInner>` (not dynamic) preserves the LAKE-ENVELOPE; the client
 * build swaps that import for the render-nothing stub. `lang` is the wrapper `<script>` lang.
 */
export function lake_wrapper_source(
	iid: string,
	componentPath: string,
	options: Record<string, unknown> | undefined,
	exportName: string | undefined,
	lang: string
): string {
	const remount = options?.remount || 'cache';
	const needs_endpoint = remount === 'swr';
	const when = options?.when || (needs_endpoint ? 'load' : undefined);
	let attrs = `__entry={${JSON.stringify(iid)}} __remount={${JSON.stringify(remount)}}`;
	if (options?.maxAgeMs != null) attrs += ` __maxAge={${JSON.stringify(options.maxAgeMs)}}`;
	if (options?.onExpire) attrs += ` __onExpire={${JSON.stringify(options.onExpire)}}`;
	if (needs_endpoint) {
		attrs += ` __when={${JSON.stringify(when || 'load')}} __props={__props}`;
		if (options?.margin != null) attrs += ` __margin={${JSON.stringify(options.margin)}}`;
	}
	return (
		`<script${lang}>\n` +
		`\timport { Region as OgygiaRegion__Wrapper } from 'ogygia/internal';\n` +
		`\t${component_import_line('OgygiaLakeInner', componentPath, exportName)}\n` +
		`\tlet __props = $props();\n` +
		`</script>\n` +
		`<OgygiaRegion__Wrapper __mode="lake" ${attrs}>` +
		`<OgygiaLakeInner {...__props} /></OgygiaRegion__Wrapper>\n`
	);
}

/** Map a hydrate strategy (+ options) to the Island wrapper attribute markup. */
export function strategy_to_attr(strategy: string, options?: Record<string, unknown>): string {
	if (!strategy || strategy === 'load') return 'load';
	if (strategy === 'idle') return 'idle';
	if (strategy === 'interaction') return 'interaction';
	if (strategy === 'visible') {
		// `margin` (IntersectionObserver rootMargin) rides as the string form of `visible`.
		return options && options.margin != null ? `visible=${JSON.stringify(options.margin)}` : 'visible';
	}
	// media query (the strategy IS the query string)
	return `media=${JSON.stringify(strategy)}`;
}
