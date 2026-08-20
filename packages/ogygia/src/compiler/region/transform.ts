import { parse } from 'svelte/compiler';
import MagicString from 'magic-string';
import { createHash } from 'node:crypto';
import { foucCssVirtualId } from '../fouc-css.js';
import { collectCaptureInfo } from '../free-vars.js';
import { parse_module } from '../parse/oxc.js';
import { strategyKey, regionIdentity, regionId } from './identity.js';

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const PATH_SEP = /[/\\]/;
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i;
const JS_EXT = /\.js$/;
const WRAP_QUOTES = /^['"]|['"]$/g;

export { foucCssVirtualId } from '../fouc-css.js';

export const ISLAND_DIR = '.ogygia';

/**
 * Default import-attribute keys — the two-dial grammar. Internal role names stay `hydrate`/`defer`
 * (the wire format + runtime keep those anchors); the user-facing ATTRIBUTE names are the values.
 * Override via `ogygia({ importKeys })`.
 * - `render` attribute → the MODE: `static` (inline HTML) | `deferred` (a hole, fetched) | `live`
 *   (a hole that revalidates). Defaults to `static`.
 * - `wake` attribute → when the region comes alive: for `static` that is HYDRATION; for
 *   `deferred`/`live` that is the FETCH schedule.
 */
export const DEFAULT_IMPORT_KEYS = {
	wake: 'wake',
	render: 'render',
	preset: 'preset',
	region: 'region'
} as const;

/**
 * Import-attribute key names claimed by the transform
 * (`with { wake | render | preset | region }`). Override via `ogygia({ importKeys })` when
 * another tool already uses the default names.
 */
export type ImportKeys = {
	/** When the region comes alive (default attribute `'wake'`) — hydration for `static`, the fetch
	 * schedule for `deferred`/`live`. */
	wake: string;
	/** The delivery MODE (default attribute `'render'`): `static` | `deferred` | `live`. */
	render: string;
	/** Named preset attribute (default `'preset'`). */
	preset: string;
	/** Held-across-a-boundary marker (default attribute `'region'`, only value `'raw'`) — a component
	 * a registry hands to `region()` where the transform can't see the call. */
	region: string;
};

/** The three delivery modes the `render` attribute accepts. */
const RENDER_MODES = new Set(['static', 'deferred', 'live']);

const JS_IDENT = /^[A-Za-z_$][\w$]*$/;

// Invariant per-build — hoisted to module scope so they aren't reallocated on every transformHost.
const KNOWN_STRATEGIES = new Set(['load', 'idle', 'visible']);
// `interaction` is a wake-only schedule (first pointer/key/focus inside the region, with click
// replay) — a wake-only schedule, never a deferred fetch timing.
const HYDRATE_STRATEGIES = new Set([...KNOWN_STRATEGIES, 'interaction']);
/** Inline attribute keys accepted after normalization (canonical internal names). */
const ATTR_SCHEMA = new Set(['hydrate', 'defer', 'margin', 'keep']);
/** AST fragment child-key names walked when descending the template. */
const CHILD_KEYS = ['consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch', 'fragment'];

/**
 * Merge partial `importKeys` with {@link DEFAULT_IMPORT_KEYS}.
 * Rejects empty strings, non-identifiers, and colliding role names.
 *
 * @param overrides - Optional overrides for one or more roles.
 * @returns Fully resolved key map used by the transform.
 * @throws If a value is not a JS identifier or two roles share the same name.
 */
// Memoize by the overrides object so repeated calls with the same config (every module, every leg)
// return ONE stable ImportKeys — which lets `import_keys_hint`'s WeakMap actually hit.
const NORMALIZED_CACHE = new WeakMap<object, ImportKeys>();
let DEFAULT_NORMALIZED: ImportKeys | null = null;
export function normalize_import_keys(overrides?: Partial<ImportKeys> | null): ImportKeys {
	if (overrides == null) return (DEFAULT_NORMALIZED ??= normalize_import_keys_uncached(null));
	const hit = NORMALIZED_CACHE.get(overrides);
	if (hit) return hit;
	const result = normalize_import_keys_uncached(overrides);
	NORMALIZED_CACHE.set(overrides, result);
	return result;
}

function normalize_import_keys_uncached(overrides?: Partial<ImportKeys> | null): ImportKeys {
	const wake = (overrides?.wake ?? DEFAULT_IMPORT_KEYS.wake).trim();
	const render = (overrides?.render ?? DEFAULT_IMPORT_KEYS.render).trim();
	const preset = (overrides?.preset ?? DEFAULT_IMPORT_KEYS.preset).trim();
	const region = (overrides?.region ?? DEFAULT_IMPORT_KEYS.region).trim();
	for (const [role, name] of [
		['wake', wake],
		['render', render],
		['preset', preset],
		['region', region]
	] as const) {
		if (!name || !JS_IDENT.test(name)) {
			throw new Error(
				`[ogygia] importKeys.${role} must be a non-empty JS identifier (got ${JSON.stringify(overrides?.[role])}).`
			);
		}
	}
	if (new Set([wake, render, preset, region]).size !== 4) {
		throw new Error(
			'[ogygia] importKeys.wake, importKeys.render, importKeys.preset, and importKeys.region must be distinct.'
		);
	}
	return { wake, render, preset, region };
}

/**
 * Cheap source-scan regex matching any of the configured import-attribute key names.
 * Used to skip AST work on hosts that cannot contain region imports.
 *
 * @param import_keys - Resolved key map from {@link normalize_import_keys}.
 */
/** Memoized hint regex per resolved key map — `import_keys` is build-invariant, so the RegExp is
 * compiled once instead of on every `transformHost` call (per module, per leg). */
const HINT_CACHE = new WeakMap<ImportKeys, RegExp>();
export function import_keys_hint(import_keys: ImportKeys) {
	let re = HINT_CACHE.get(import_keys);
	if (re) return re;
	const esc = (s: string) => s.replace(REGEXP_META, '\\$&');
	re = new RegExp(
		`${esc(import_keys.wake)}|${esc(import_keys.render)}|${esc(import_keys.preset)}|${esc(import_keys.region)}`
	);
	HINT_CACHE.set(import_keys, re);
	return re;
}

/** Deterministic short id for a region (stable across dev + build).
 * When `salt` is set (production `OGYGIA_SECRET`), ids are not offline-computable (P1-ID).
 * Paths are always posix so SSR/client builds agree across OS path separators. */
export function islandId(relHostPath: string, index: string | number, salt = '') {
	const rel = String(relHostPath).split(PATH_SEP).join('/');
	const msg = salt ? `${salt}\0${rel}::${index}` : `${rel}::${index}`;
	return createHash('md5').update(msg).digest('hex').slice(0, 12);
}

/**
 * Deterministic client chunk path for a hydrate island (mirrors `og-runtime.<hash>.js`).
 * SSR bakes this into `<ogygia-region entry>` so the sticky runtime can `import(entry)` with no
 * app-wide regions map — Kit builds server before client, so content-hashed Vite names can't hand off.
 */
export function islandChunkFileName(iid: string) {
	return `_app/immutable/og-region.${iid}.js`;
}

/** Public URL for {@link islandChunkFileName} (leading slash, same shape as runtime-url). */
export function islandPublicUrl(iid: string) {
	return '/' + islandChunkFileName(iid);
}

/** Portable wrapper module id — SSR / csr=true host binding (Island/ServerIsland/Lake shell). */
export function wrapperVirtualId(iid: string) {
	return `virtual:ogygia/wrapper/${iid}.svelte`;
}

/**
 * Region-binding module id. A `with { region: 'raw' }` import is rewritten to import this JS
 * module, whose source is leg-split by the plugin `load` hook: the SSR leg carries the server
 * signer (so `region()` can mint a capability), the client leg is metadata-only (no server
 * code crosses into the browser bundle).
 */
export function regionBindingVirtualId(iid: string) {
	return `virtual:ogygia/region/${iid}.js`;
}

/**
 * csr=false CLIENT host binding target. Kit still emits those page nodes; pointing marked
 * imports here (instead of wrappers) keeps N island wrappers/entries out of the page graph so
 * `emitFile` owns hydrate modules and Rolldown does not thin-facade them. Hydration uses
 * `import(entry)` only — this stub is never loaded for island JS.
 *
 * Beside the stub the transform emits `import 'virtual:ogygia/fouc-css/<entry>'` so Kit still
 * links stylesheets (FOUC) via CSS-only side effects. Importing the full `.svelte` JS module
 * dual-owns it with the emitFile island entry and Rolldown thin-facades `og-region.*`.
 * Omitting CSS entirely orphans rules (scoped class hashes, no stylesheet).
 */
export const CLIENT_BINDING_STUB = 'virtual:ogygia/client-binding-stub';

// The join key — region identity (strategyKey / regionIdentity / regionId) now lives in ./identity.ts.
// Imported for the lowering below and re-exported so the public `ogygia/internal/compiler` surface
// (export * from transform) is unchanged.
export { strategyKey, regionIdentity, regionId };

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

/** True if `val` looks like a CSS media query (must contain a balanced-ish `(…)`). */
function is_media_query(val: string) {
	const open = val.indexOf('(');
	return open !== -1 && val.indexOf(')', open) !== -1;
}

/**
 * Is `node` the member expression `import.meta.og.<prop>` (the macro namespace head)? Used to spot an
 * `import.meta.og.asRegion(…)` call — the macro alternative to a `with { wake }` region import.
 */
function is_import_meta_og(node: any, prop: string): boolean {
	return (
		node?.type === 'MemberExpression' &&
		node.property?.type === 'Identifier' &&
		node.property.name === prop &&
		node.object?.type === 'MemberExpression' &&
		node.object.property?.type === 'Identifier' &&
		node.object.property.name === 'og' &&
		node.object.object?.type === 'MetaProperty' &&
		node.object.object.meta?.name === 'import' &&
		node.object.object.property?.name === 'meta'
	);
}

/**
 * Resolve a local name back to its import binding — the module specifier plus the EXPORT NAME it
 * imports (`'default'` for `import X`, the imported name for `import { X }` / `import { A as X }`).
 * Feeds asRegion: the island entry re-imports the component by this export name (barrel-friendly), and
 * region identity keys on `source#exportName`. Namespace imports (`import * as X`) return `{ namespace }`.
 */
function import_binding_of(
	node: any,
	localName: string
): { source: string; exportName: string } | { namespace: true } | null {
	for (const spec of node.specifiers ?? []) {
		if (spec.local?.name !== localName) continue;
		if (spec.type === 'ImportDefaultSpecifier') return { source: node.source.value, exportName: 'default' };
		if (spec.type === 'ImportSpecifier') {
			const imported = spec.imported;
			const name = imported?.type === 'Literal' ? String(imported.value) : imported?.name;
			return { source: node.source.value, exportName: name };
		}
		if (spec.type === 'ImportNamespaceSpecifier') return { namespace: true };
	}
	return null;
}

/**
 * Parse an `asRegion` options object in a `.ts`/`.js` file into a `.ts` region marker — `{ wake }` or
 * `{ region }`, the same option surface a `with { … }` import attribute has there. `fail(msg)` throws
 * the caller's contextual error.
 */
function parse_ts_as_region_options(
	arg: any,
	fail: (msg: string) => Error,
	regionKey: string,
	wakeKey: string
): { region?: string; wake?: string } {
	if (!arg || arg.type !== 'ObjectExpression')
		throw fail(`needs an options object — e.g. \`import.meta.og.asRegion(Comp, { wake: 'load' })\`.`);
	let region: string | undefined;
	let wake: string | undefined;
	for (const p of arg.properties ?? []) {
		if (p.type !== 'Property' || p.computed) throw fail('options must be a plain object of string-valued keys.');
		const key = p.key?.name ?? p.key?.value;
		if (p.value?.type !== 'Literal' || typeof p.value.value !== 'string')
			throw fail(`option \`${key}\` must be a string literal.`);
		const val = String(p.value.value);
		if (key === regionKey || key === 'region') region = val;
		else if (key === wakeKey || key === 'wake') wake = val;
		else throw fail(`unknown option \`${key}\` — a .ts region takes \`wake: '…'\` or \`region: 'raw'\`.`);
	}
	if (region != null && wake != null) throw fail('takes exactly one of `wake` or `region`.');
	if (region != null) return { region };
	if (wake != null) return { wake };
	throw fail('needs a `wake` or `region` option.');
}

/**
 * The `with { region: … }` marker has ONE value — `'raw'` (an adjective: "a raw/held region"). It
 * carries NO schedule: the wake timing is set at the `region()` call (`region(C, props, { wake })`)
 * or, in a block tree, per node. This is the only surviving import-attribute marker for a component
 * a registry hands to `region()` where the transform can't see the call site.
 *
 * @param {string} raw the marker value
 * @param {string} where host label for error messages
 * @param {string} regionKey configured `region` attribute name (for the message)
 */
export function normalize_region_value(raw: string, where: string, regionKey = 'region'): void {
	const v = (raw ?? '').trim();
	if (v === 'raw') return;
	throw new Error(
		`[ogygia] ${where}: \`${regionKey}\` only takes the value 'raw' (a held region with no baked ` +
			`schedule). To bake a schedule use a \`wake:\` mark, or set it at the \`region()\` call.`
	);
}

/**
 * Validate a `wake:` schedule value on a held import (a `.ts` registry / remote). Accepts the wake
 * strategies (`load` / `idle` / `visible` / `interaction`) or a media query — the same vocabulary as
 * a placed island's `wake:`. Returns the value unchanged (it becomes the baked `__hydrate`).
 */
export function normalize_hydrate_value(raw: string, where: string, wakeKey = 'wake'): string {
	const v = (raw ?? '').trim();
	if (HYDRATE_STRATEGIES.has(v) || is_media_query(v)) return v;
	throw new Error(
		`[ogygia] ${where}: unknown \`${wakeKey}\` strategy '${v}'. Use 'load' | 'idle' | 'visible' | 'interaction' | a media query.`
	);
}

/**
 * The component-import line for a generated module — a NAMED export (`import { Header as X } from
 * '@barrel'`, the asRegion/barrel escape hatch) or a plain default (`import X from './X.svelte'`, a
 * `.svelte` file or a package default). `exportName` is undefined/`'default'` for the default case.
 */
function component_import_line(local: string, spec: string, exportName?: string): string {
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
function island_entry_source(componentPath: string, iid: string, exportName?: string): string {
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
function island_wrapper_source(
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
function make_region_binding(opts: {
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
function make_wake_island(opts: {
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

/** Reconstruct an import declaration without its `with { ... }` attributes clause. */
function clean_import_text(source, node) {
	// slice up to the end of the module-specifier string literal, then terminate.
	return source.slice(node.start, node.source.end) + ';';
}

/**
 * Region keys (`hydrate` / `defer` / `preset` under configured names) on a dynamic
 * `import(spec, { with: { … } })` / `{ assert: { … } }` options object.
 * Returns `[]` when the call has no options or no claimed region keys.
 *
 * @param {import('estree').ImportExpression} node
 * @param {ImportKeys} import_keys
 * @returns {string[]}
 */
function region_keys_on_dynamic_import(node, import_keys) {
	const opts = node.options;
	if (!opts || opts.type !== 'ObjectExpression') return [];
	const claimed = new Set([import_keys.wake, import_keys.render, import_keys.preset]);
	/** @type {string[]} */
	const found = [];
	for (const prop of opts.properties) {
		if (prop.type !== 'Property' || prop.computed) continue;
		const bag_key =
			prop.key.type === 'Identifier'
				? prop.key.name
				: prop.key.type === 'Literal'
					? String(prop.key.value)
					: null;
		// Spec uses `with`; older tooling may still emit `assert`.
		if (bag_key !== 'with' && bag_key !== 'assert') continue;
		if (prop.value.type !== 'ObjectExpression') continue;
		for (const atr of prop.value.properties) {
			if (atr.type !== 'Property' || atr.computed) continue;
			const ak =
				atr.key.type === 'Identifier'
					? atr.key.name
					: atr.key.type === 'Literal'
						? String(atr.key.value)
						: null;
			if (ak && claimed.has(ak) && !found.includes(ak)) found.push(ak);
		}
	}
	return found;
}

/**
 * Walk a script Program body for `ImportExpression` nodes carrying ogygia region keys.
 * Dynamic `import()` cannot author islands — SSR shells need a static marked import binding.
 *
 * @param {unknown[]} body
 * @param {ImportKeys} import_keys
 * @param {(keys: string[]) => never} fail
 */
function reject_dynamic_region_imports(body, import_keys, fail) {
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		if (/** @type {{ type?: string }} */ (node).type === 'ImportExpression') {
			const keys = region_keys_on_dynamic_import(
				/** @type {import('estree').ImportExpression} */ (node),
				import_keys
			);
			if (keys.length) fail(keys);
		}
		for (const k of Object.keys(node)) {
			if (k === 'start' || k === 'end' || k === 'loc') continue;
			const v = /** @type {Record<string, unknown>} */ (node)[k];
			if (Array.isArray(v)) for (const c of v) walk(c);
			else if (v && typeof v === 'object' && typeof /** @type {{ type?: string }} */ (v).type === 'string')
				walk(v);
		}
	};
	for (const n of body ?? []) walk(n);
}

function script_lang_attr(scriptNode) {
	if (!scriptNode) return '';
	for (const attr of scriptNode.attributes ?? []) {
		if (attr.name === 'lang' && Array.isArray(attr.value) && attr.value[0]?.data) {
			return ` lang="${attr.value[0].data}"`;
		}
	}
	return '';
}

/** Map a hydrate strategy (+ options) to the Island wrapper attribute markup. */
function strategy_to_attr(strategy, options) {
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

const REMOUNT_SHORTHANDS = new Set(['cache', 'empty', 'swr']);
const REMOUNT_ON_EXPIRE = new Set(['empty', 'fetch']);
/** Schedule keywords shared by `hydrate`, `defer` and `remount.revalidate`. */
const SCHEDULE_KEYWORDS = new Set(['load', 'idle', 'visible']);

/**
 * Parse `remount.maxAge` — number (ms) or duration string (`30s` / `5m` / `1h` / `500ms`).
 * @returns {number | undefined} milliseconds
 */
function parse_max_age(raw, err, names) {
	if (raw == null) return undefined;
	if (typeof raw === 'number') {
		if (!Number.isFinite(raw) || raw < 0) {
			throw err(names, `\`remount.maxAge\` must be a non-negative number (ms), got ${raw}.`);
		}
		return Math.floor(raw);
	}
	if (typeof raw === 'string') {
		const m = raw.trim().match(DURATION);
		if (!m) {
			throw err(
				names,
				`unknown remount.maxAge '${raw}'. Use a number (ms) or a duration like '30s' | '5m' | '1h'.`
			);
		}
		const n = Number(m[1]);
		const unit = (m[2] || 'ms').toLowerCase();
		const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
		return Math.floor(n * mult);
	}
	throw err(names, `\`remount.maxAge\` must be a number (ms) or duration string.`);
}

/**
 * Parse a deferred hole's `maxAge` → response cache max-age in **seconds**. Unlike `remount.maxAge`
 * (client staleness, ms), this is an HTTP header value, so a bare number is SECONDS; duration units
 * (`'30s'` / `'5m'` / `'1h'`, or `'500ms'` rounded down) are converted to seconds. `0` = no-store.
 * @returns {number | undefined} seconds
 */
function parse_cache_ttl_sec(raw, err, names) {
	if (raw == null) return undefined;
	if (typeof raw === 'number') {
		if (!Number.isFinite(raw) || raw < 0) {
			throw err(names, `\`maxAge\` must be a non-negative number of seconds, got ${raw}.`);
		}
		return Math.floor(raw);
	}
	if (typeof raw === 'string') {
		const m = raw.trim().match(DURATION);
		if (!m) {
			throw err(
				names,
				`unknown \`maxAge\` '${raw}'. Use seconds (a number) or a duration like '30s' | '5m' | '1h'.`
			);
		}
		const n = Number(m[1]);
		const unit = (m[2] || 's').toLowerCase(); // bare number = seconds for an HTTP cache
		const secs = unit === 'ms' ? n / 1000 : unit === 's' ? n : unit === 'm' ? n * 60 : n * 3600;
		return Math.floor(secs);
	}
	throw err(names, `\`maxAge\` must be a number of seconds or a duration string.`);
}

/**
 * Normalize preset `remount`.
 *
 * Shorthands: `'cache'` | `'empty'` | `'swr'` (`swr` ≡ `{ revalidate: 'load' }`).
 * Object: `{ revalidate?: false | schedule, maxAge?, onExpire?: 'empty' | 'fetch' }`.
 *
 * @returns {{ policy: 'cache'|'empty'|'swr', when?: string, maxAgeMs?: number, onExpire?: string } | undefined}
 */
function parse_remount(raw, err, names) {
	if (raw == null) return undefined;
	if (typeof raw === 'string') {
		if (!REMOUNT_SHORTHANDS.has(raw)) {
			throw err(names, `unknown remount '${raw}'. Use 'cache' | 'empty' | 'swr'.`);
		}
		if (raw === 'swr') return { policy: 'swr', when: 'load' };
		return { policy: raw };
	}
	if (typeof raw !== 'object' || raw === null) {
		throw err(
			names,
			`\`remount\` must be 'cache' | 'empty' | 'swr' or \`{ revalidate?, maxAge?, onExpire? }\`.`
		);
	}
	if ('strategy' in raw || 'when' in raw) {
		throw err(
			names,
			`\`remount\` object uses \`revalidate\` (false | 'load' | 'idle' | 'visible' | media), not \`strategy\`/\`when\`. ` +
				`Examples: { revalidate: false, maxAge: '5m' } or { revalidate: 'idle' }. Shorthands: 'cache' | 'empty' | 'swr'.`
		);
	}
	for (const k of Object.keys(raw)) {
		if (k !== 'revalidate' && k !== 'maxAge' && k !== 'onExpire') {
			throw err(names, `unknown remount key '${k}'. Use revalidate, maxAge, onExpire.`);
		}
	}
	if (raw.revalidate == null && raw.maxAge == null && raw.onExpire == null) {
		throw err(
			names,
			`\`remount\` object needs revalidate, maxAge, and/or onExpire — or use the 'cache' | 'empty' | 'swr' shorthand.`
		);
	}

	const out: { policy: string; when?: string; maxAgeMs?: number; onExpire?: string } = {
		policy: 'cache'
	};

	if (raw.revalidate === false || raw.revalidate == null) {
		out.policy = 'cache';
	} else if (raw.revalidate === true) {
		throw err(names, `\`remount.revalidate: true\` is invalid — use 'load' (or 'idle' | 'visible' | a media query).`);
	} else {
		const rev = String(raw.revalidate);
		if (!SCHEDULE_KEYWORDS.has(rev) && !is_media_query(rev)) {
			throw err(
				names,
				`unknown remount.revalidate '${rev}'. Use false | 'load' | 'idle' | 'visible' | a media query.`
			);
		}
		out.policy = 'swr';
		out.when = rev;
	}

	if (raw.onExpire != null) {
		const oe = String(raw.onExpire);
		if (!REMOUNT_ON_EXPIRE.has(oe)) {
			throw err(names, `unknown remount.onExpire '${oe}'. Use 'empty' | 'fetch'.`);
		}
		if (out.policy === 'cache' && oe === 'fetch') {
			throw err(
				names,
				`\`onExpire: 'fetch'\` requires \`revalidate\` (a schedule). Pure cache expires to empty — ` +
					`use { revalidate: 'load', maxAge, onExpire: 'fetch' } for SWR past maxAge.`
			);
		}
		out.onExpire = oe;
	}

	if (raw.maxAge != null) {
		out.maxAgeMs = parse_max_age(raw.maxAge, err, names);
	}

	return out;
}


/**
 * Svelte 5 event attributes (`onclick`, …) that cannot cross devalue for remount:swr.
 * Deliberately NOT `/^on[a-z]+$/` — that falsely rejects data props like `online={x}`.
 */
const SWR_EVENT_ATTR = new Set([
	'onclick',
	'ondblclick',
	'oncontextmenu',
	'onauxclick',
	'onpointerdown',
	'onpointerup',
	'onpointermove',
	'onpointerenter',
	'onpointerleave',
	'onpointercancel',
	'onpointerover',
	'onpointerout',
	'onmousedown',
	'onmouseup',
	'onmousemove',
	'onmouseenter',
	'onmouseleave',
	'onmouseover',
	'onmouseout',
	'onkeydown',
	'onkeyup',
	'onkeypress',
	'onfocus',
	'onblur',
	'onfocusin',
	'onfocusout',
	'oninput',
	'onbeforeinput',
	'onchange',
	'onsubmit',
	'onreset',
	'onscroll',
	'onwheel',
	'ontouchstart',
	'ontouchend',
	'ontouchmove',
	'ontouchcancel',
	'ondrag',
	'ondragstart',
	'ondragend',
	'ondragenter',
	'ondragleave',
	'ondragover',
	'ondrop',
	'oncopy',
	'oncut',
	'onpaste',
	'onanimationstart',
	'onanimationend',
	'onanimationiteration',
	'ontransitionend',
	'ontransitionrun',
	'ontransitionstart',
	'ontransitioncancel',
	'onload',
	'onerror',
	'ontoggle',
	'onselect',
	'oninvalid',
	'onformdata'
]);

/**
 * Everything a `render: 'live'` region needs must survive the wire: the endpoint re-renders the
 * component from devalue'd PROPS alone. Children (snippets) and `bind:` targets cannot cross, and
 * silently losing them on revalidate would be worse than refusing the build.
 */
function assert_swr_lake_crossable(node, err) {
	const kids = (node.fragment?.nodes ?? []).filter(
		(n) => !(n.type === 'Text' && !String(n.data ?? '').trim())
	);
	if (kids.length) {
		throw err(
			node.name,
			`\`render: 'live'\` region <${node.name}> cannot have children — the revalidate endpoint re-renders it from serialized props only, so snippets cannot cross. Move the content inside the component, or make it a static lake with \`wake: 'none'\`.`
		);
	}
	for (const attr of node.attributes ?? []) {
		if (attr.type === 'SpreadAttribute') continue;
		if (attr.type !== 'Attribute') {
			throw err(
				node.name,
				`\`render: 'live'\` region <${node.name}> cannot use \`${attr.type === 'BindDirective' ? 'bind:' + attr.name : attr.name || attr.type}\` — only plain attributes and spreads can be serialized for the revalidate endpoint.`
			);
		}
		const name = attr.name;
		// Svelte 5 event attributes are lowercase `onclick` / `onpointerdown` / … (distinct from
		// `on:click` OnDirective, already rejected above). Callback props with that shape cannot
		// cross devalue — rejecting at build avoids a silent remount:'cache' degrade at mint.
		// Match known DOM events only — `/^on[a-z]+$/` falsely rejects data props like `online={x}`.
		if (typeof name === 'string' && SWR_EVENT_ATTR.has(name)) {
			throw err(
				node.name,
				`\`render: 'live'\` region <${node.name}> cannot use \`${name}\` — event/callback attributes cannot be serialized for the revalidate endpoint. Pass serializable data props instead.`
			);
		}
		// Inline function values on any attr (`render={() => …}`) likewise cannot cross.
		const val = attr.value;
		const chunk_list = Array.isArray(val) ? val : val != null && val !== true ? [val] : [];
		for (const chunk of chunk_list) {
			const t = chunk?.expression?.type;
			if (t === 'ArrowFunctionExpression' || t === 'FunctionExpression') {
				throw err(
					node.name,
					`\`render: 'live'\` region <${node.name}> cannot use a function value for \`${name}\` — functions cannot be serialized for the revalidate endpoint.`
				);
			}
		}
	}
}

/**
 * Resolve a marked import specifier to the component path baked into generated modules.
 *
 * `$lib` + relative specifiers resolve to ABSOLUTE file paths (build machinery — emitFile prescan,
 * HMR invalidation, fouc-css — keys on them). Anything else (a PACKAGE specifier like
 * `'ogygia/content/tab-group'`, or a Vite alias) is kept VERBATIM: every generated virtual module
 * (island entry, wrapper, child synth, region binding) re-emits the original specifier and Vite's
 * resolver handles it — exports map, workspace link, or alias — so both a node_modules install and
 * a monorepo workspace link work without this transform ever touching the filesystem. A marked
 * specifier Vite cannot resolve fails loudly at resolve time (see the plugin's resolveId hook).
 */
function resolve_component_path(spec, host_id, ctx) {
	if (typeof spec !== 'string' || !spec.trim()) return null;
	if (spec === '$lib' || spec.startsWith('$lib/')) {
		return ctx.pathModule.join(ctx.libDir, spec === '$lib' ? '' : spec.slice('$lib/'.length));
	}
	if (spec.startsWith('.')) {
		return ctx.pathModule.resolve(ctx.pathModule.dirname(host_id), spec);
	}
	// Package / alias / absolute specifier — re-emitted verbatim into generated modules.
	return spec;
}

/**
 * @typedef {Object} TransformResult
 * @property {string} code rewritten host source
 * @property {unknown} map source map
 * @property {Array<{id:string, virtualPath:string, source:string, hostPath:string}>} islands
 */

/**
 * @param {string} source
 * @param {string} id absolute host path
 * @param {Object} ctx
 * @param {string} ctx.root project root (abs)
 * @param {string} ctx.libDir abs path for `$lib`
 * @param {(abs:string)=>string|null} ctx.readFile sync file reader for filename-strategy lookup
 * @param {(hostPath:string, index:number)=>string} ctx.virtualPathFor virtual module id for an island
 * @returns {TransformResult|null}
 */
// Injected into every csr=true route host. Marks the subtree "csr=true" via a BARE svelte
// `setContext` — no ogygia import — so a region-less csr=true page still ships zero ogygia. Region
// reads it (isCsrTrue) and renders islands inline. The host renders on both the SSR and Kit-client
// legs, so the flag is identical on both → the inline/island choice can never desync at hydrate.
// KEY STRING (CSR-KEY): must equal context.ts `CSR_TRUE_KEY` — `Symbol.for('ogygia.csr-true')`.
const CSR_CTX_INJECT =
	`import { setContext as __og_setctx } from 'svelte'; __og_setctx(Symbol.for('ogygia.csr-true'), true);\n`;

/**
 * csr=true route host: strip marked imports to plain, then inject the csr-context marker.
 * @param {string} source @param {string} id @param {boolean} has_island_hint @param {ImportKeys} import_keys
 * @returns {TransformResult|null}
 */
function transform_csr_true_host(source, id, has_island_hint, import_keys) {
	let ast;
	try {
		ast = parse(source, { modern: true, filename: id });
	} catch {
		return null;
	}
	const ms = new MagicString(source);

	// Strip `with { wake|render|preset|region }` off host imports → plain imports (Kit compiles them).
	if (has_island_hint) {
		const region_keys = new Set([
			import_keys.wake,
			import_keys.render,
			import_keys.preset,
			import_keys.region
		]);
		for (const node of ast.instance?.content?.body ?? []) {
			if (node.type !== 'ImportDeclaration') continue;
			const attrs = (node.attributes ?? []).filter((a) => a.type === 'ImportAttribute');
			if (!attrs.some((a) => region_keys.has(a.key.name ?? a.key.value))) continue;
			ms.overwrite(node.start, node.end, clean_import_text(source, node));
		}
	}

	// asRegion in a csr=true host degrades to the plain component (Kit renders it inline, no island):
	// rewrite `const X = import.meta.og.asRegion(Comp, …)` → `const X = Comp`.
	for (const node of ast.instance?.content?.body ?? []) {
		if (node.type !== 'VariableDeclaration') continue;
		for (const decl of node.declarations) {
			const call = decl.init;
			if (call?.type === 'CallExpression' && is_import_meta_og(call.callee, 'asRegion')) {
				const comp = call.arguments?.[0];
				if (comp?.type === 'Identifier') ms.overwrite(call.start, call.end, comp.name);
			}
		}
	}

	// Inject the csr-context marker at the top of the instance <script> (create one if absent —
	// a `<script module>` runs once per module, not per instance, so it can't carry setContext).
	if (ast.instance?.content) {
		ms.appendLeft(ast.instance.content.start, `\n${CSR_CTX_INJECT}`);
	} else {
		ms.prepend(`<script>${CSR_CTX_INJECT}</script>\n`);
	}

	return {
		code: ms.toString(),
		map: ms.generateMap({ hires: true, source: id, includeContent: true }),
		islands: []
	};
}

// Injected into every csr=FALSE route host to RESET the inherited csr-true flag. Svelte context
// flows to ALL descendants, and Kit's csr option is per-node: a csr=true ANCESTOR layout (e.g. a
// root `+layout.svelte` with no `csr` export → Kit default `true`) sets `true` via CSR_CTX_INJECT,
// and a `csr = false` CHILD layout re-shadows it — exactly like Kit's own option resolution
// (`{ ...parent_options, ...own }`). Without the reset, every island in a csr=false subtree under a
// csr=true ancestor reads `true` (isCsrTrue) and degrades to INLINE — no `<ogygia-region>`, no
// hydration, silently. A csr=true host BELOW the reset injects `true` again, so shadowing works in
// both directions. Same bare-svelte `setContext` + KEY STRING as CSR_CTX_INJECT (CSR-KEY).
const CSR_FALSE_INJECT =
	`import { setContext as __og_setctx } from 'svelte'; __og_setctx(Symbol.for('ogygia.csr-true'), false);\n`;

/**
 * csr=false route host with no island/portable work of its own: inject ONLY the csr-false reset
 * marker (no import stripping — csr=false keeps its islands), so islands rendered BELOW it (shared
 * components in its template, slot content) island correctly even under a csr=true ancestor layout.
 * @param {string} source @param {string} id
 * @param {ReturnType<typeof parse>} [parsed] already-parsed AST (avoids a re-parse)
 * @returns {TransformResult|null}
 */
function inject_csr_reset(source, id, parsed = null) {
	let ast = parsed;
	if (!ast) {
		try {
			ast = parse(source, { modern: true, filename: id });
		} catch {
			return null;
		}
	}
	const ms = new MagicString(source);
	if (ast.instance?.content) ms.appendLeft(ast.instance.content.start, `\n${CSR_FALSE_INJECT}`);
	else ms.prepend(`<script>${CSR_FALSE_INJECT}</script>\n`);
	return {
		code: ms.toString(),
		map: ms.generateMap({ hires: true, source: id, includeContent: true }),
		islands: []
	};
}

export function transformHost(source, id, ctx) {
	const import_keys = normalize_import_keys(ctx.importKeys);
	const has_island_hint = import_keys_hint(import_keys).test(source);

	// Route hosts carry Kit's per-node csr option as a Svelte context marker (CSR-KEY), mirroring
	// Kit's own option resolution (`{ ...parent_options, ...own }`) so nesting shadows correctly:
	//   routeCsr === true  → strip islands + inject `true` (Kit hydrates; islands degrade inline).
	//   routeCsr === false → keep islands + inject the `false` RESET (a csr=true ANCESTOR — e.g. an
	//                        option-less root layout, Kit default true — would otherwise leak `true`
	//                        down and silently degrade every island in the csr=false subtree).
	//   routeCsr undefined → not a route host (shared component): no marker; its csr depends on the
	//                        page that renders it, so it keeps its islands and reads the context.
	// csr=true must run even for a MARKER-LESS host (a page that only uses `<Region>`, no
	// `with { wake }`), so it precedes the island-hint bailout. (`.ts` held regions and
	// deferred/live/lake regions are server-driven UI, orthogonal to a page's csr — they are
	// deliberately NOT degraded; see Region.svelte `is_csr`.)
	if (ctx.routeCsr === true) return transform_csr_true_host(source, id, has_island_hint, import_keys);
	const needs_csr_reset = ctx.routeCsr === false;

	// cheap bailout — the library only touches region imports (configured key names), PLUS files that
	// define a `{#snippet}` (a candidate portable snippet forwarded into an island) or call the
	// `import.meta.og.asRegion(…)` macro. Files with none of those return `null` unchanged at the end.
	// A csr=false route host is never a pure bailout: it always carries the reset marker.
	if (!has_island_hint && !source.includes('{#snippet') && !source.includes('asRegion')) {
		return needs_csr_reset ? inject_csr_reset(source, id) : null;
	}

	let ast;
	try {
		ast = parse(source, { modern: true, filename: id });
	} catch {
		return null;
	}

	const instance_body = ast.instance?.content?.body ?? [];
	const module_body = ast.module?.content?.body ?? [];
	const lang = script_lang_attr(ast.instance) || script_lang_attr(ast.module);

	const path = ctx.pathModule;
	// Posix-relative host path — island ids must not drift across Windows/POSIX build legs.
	const rel_host = path.relative(ctx.root, id).split(PATH_SEP).join('/');

	// Dynamic `import(mod, { with: { hydrate|defer|preset } })` is NOT an authoring path.
	// JS/Vite accept the options shape for std attributes (e.g. `type: 'json'`), but:
	//   - Vite strips import attributes from emitted dynamic imports (browser compat),
	//   - runtimes reject unknown keys like `hydrate` if left in place,
	//   - ogygia islands need a static import + a static `<Tag />` so SSR can emit the shell.
	// Fail at transform time with the working alternatives rather than silently no-op.
	reject_dynamic_region_imports(instance_body, import_keys, (keys) => {
		throw new Error(
			`[ogygia] ${rel_host}: dynamic import() with { with: { ${keys.join(', ')} } } is not supported. ` +
				`Mark islands with a static \`import X from '…' with { ${import_keys.wake}: '…' }\` ` +
				`(or \`${import_keys.render}\` / \`${import_keys.preset}\`) — the binding becomes a portable island component. ` +
				`For a click-loaded chunk that is not an island, use plain \`await import('./Comp.svelte')\` ` +
				`(no region attributes) inside a host island. ` +
				`To delay a real island until click, gate a static region import with \`{#if}\`.`
		);
	});
	reject_dynamic_region_imports(module_body, import_keys, (keys) => {
		throw new Error(
			`[ogygia] ${rel_host}: dynamic import() with { with: { ${keys.join(', ')} } } is not supported. ` +
				`Mark islands with a static \`import X from '…' with { ${import_keys.wake}: '…' }\` ` +
				`(or \`${import_keys.render}\` / \`${import_keys.preset}\`) — the binding becomes a portable island component. ` +
				`For a click-loaded chunk that is not an island, use plain \`await import('./Comp.svelte')\` ` +
				`(no region attributes) inside a host island. ` +
				`To delay a real island until click, gate a static region import with \`{#if}\`.`
		);
	});

	// --- collect host imports & region marks (the two-key region model) --------
	// The authoring syntax is the import attribute, one concern per key (`wake` = the schedule,
	// `render` = the delivery mode). These become the internal `hydrate` / `defer` DOM attributes below:
	//   import Comp from './Comp.svelte' with { wake: 'visible', margin: '200px' };
	//   import Comp from './Comp.svelte' with { wake: '(min-width: 768px)' };
	//   import Comp from './Comp.svelte' with { render: 'deferred', wake: 'load' };   // deferred HTML hole
	// Values MUST be string literals (ES import-attribute spec). See DESIGN.md.
	/** localName -> { node, cleaned } */
	const imports = new Map();
	/** localName -> { strategy, options } */
	const marked_components = new Map();
	const imports_to_strip = new Set<{ start: number; end: number }>(); // ImportDeclaration nodes to remove from host

	// The region attribute names, once per host (invariant across the import loop below).
	const REGION_KEYS = [import_keys.wake, import_keys.render, import_keys.preset, import_keys.region];

	const err = (specifiers, msg) =>
		new Error(`[ogygia] ${rel_host}: import { ${specifiers} } — ${msg}`);

	// The SINGLE source of truth for the region option surface — shared by `with { … }` import
	// attributes and `import.meta.og.asRegion(…)`. Given the attribute key→value map (import attributes
	// are always string-valued, and asRegion presents its options object the same way), return the
	// { strategy, options } mark, or null when no REGION key is present (a plain import attribute we
	// don't claim). `fail(msg)` throws the caller's contextual error. Because both entry points funnel
	// through here, asRegion accepts EXACTLY the options an import attribute does — no more, no less.
	const resolve_region_mark = (
		inline: Map<string, string>,
		fail: (msg: string) => Error
	): { strategy: string; options: Record<string, unknown> } | null => {
		const err_shim = (_names: string, msg: string) => fail(msg);
		// Retired `partial:` key → point at its replacement (only when it isn't the configured name).
		if (inline.has('partial') && !REGION_KEYS.includes('partial')) {
			throw fail(
				`the \`partial\` import attribute was retired. Mark a held-across-a-boundary component with \`${import_keys.region}: 'raw'\` (schedule set at the \`region()\` call), or bake a schedule with a \`${import_keys.wake}:\` mark.`
			);
		}
		// Only carriers of a REGION key are ours. A standard import attribute on an UNRELATED import —
		// `import data from './d.json' with { type: 'json' }` — is left untouched.
		if (!REGION_KEYS.some((k) => inline.has(k))) return null;

		// `with { region: 'raw' }` — a held region a registry hands to `region()`, minted on demand.
		if (inline.has(import_keys.region)) {
			if (inline.size > 1) {
				throw fail(
					`\`${import_keys.region}\` must be the only import attribute — it only marks a held region ('raw'); set the wake schedule at the \`region()\` call.`
				);
			}
			normalize_region_value(inline.get(import_keys.region), rel_host, import_keys.region);
			return { strategy: 'held', options: {} };
		}

		// The block carries a `render` MODE + a `wake` schedule, or a preset. No option keys inline — all
		// tuning lives in plugin config (presets). Canonical internal slots stay `hydrate`/`defer` (+live).
		const attrs = new Map<string, string>();
		let remount_opt: { policy: string; when?: string; maxAgeMs?: number; onExpire?: string } | undefined;
		let from_preset: string | null = null;
		let render_mode: string | undefined;
		let wake_val: string | undefined;
		const live_opts: { revalidate?: unknown; maxAge?: unknown; onExpire?: unknown } = {};
		if (inline.has(import_keys.preset)) {
			if (inline.size > 1) {
				throw fail(
					`\`${import_keys.preset}\` must be the only import attribute — put its options (margin, maxAge, …) in the preset definition (ogygia({ regions: { presets } })).`
				);
			}
			from_preset = inline.get(import_keys.preset)!;
			const preset = ctx.presets && ctx.presets[from_preset];
			if (!preset) {
				const avail = Object.keys(ctx.presets || {});
				throw fail(
					`unknown ${import_keys.preset} '${from_preset}'. Available: ${avail.length ? avail.join(', ') : '(none)'}.`
				);
			}
			for (const [k, v] of Object.entries(preset)) {
				if (v == null) continue;
				if (k === import_keys.render) render_mode = String(v);
				else if (k === import_keys.wake) wake_val = String(v);
				else if (k === 'maxAge' || k === 'onExpire' || k === 'revalidate') live_opts[k] = v;
				else if (k === 'margin' || k === 'keep') attrs.set(k, String(v));
				else {
					throw fail(
						`unknown key \`${k}\` in preset '${from_preset}'. Use \`${import_keys.render}\`, \`${import_keys.wake}\`, \`margin\`, \`maxAge\`, \`onExpire\`, \`revalidate\`.`
					);
				}
			}
		} else {
			for (const k of inline.keys()) {
				if (k !== import_keys.wake && k !== import_keys.render && k !== 'keep') {
					throw fail(
						`\`${k}\` is not allowed inline. Use \`${import_keys.render}\`, \`${import_keys.wake}\`, \`keep\`, or a named \`${import_keys.preset}\` — options like \`margin\` / \`maxAge\` belong in plugin config (ogygia({ regions: { presets } })).`
					);
				}
			}
			if (inline.has(import_keys.render)) render_mode = inline.get(import_keys.render);
			if (inline.has(import_keys.wake)) wake_val = inline.get(import_keys.wake);
			if (inline.has('keep')) attrs.set('keep', inline.get('keep')!);
		}

		if (render_mode != null && !RENDER_MODES.has(render_mode)) {
			throw fail(
				`unknown ${import_keys.render} '${render_mode}'. Use 'static' (inline HTML) | 'deferred' (a hole, fetched) | 'live' (a hole that revalidates).`
			);
		}
		if (render_mode === 'live') {
			attrs.set('hydrate', 'none');
			remount_opt = parse_remount(
				{
					revalidate: wake_val ?? live_opts.revalidate ?? 'load',
					...(live_opts.maxAge != null ? { maxAge: live_opts.maxAge } : {}),
					...(live_opts.onExpire != null ? { onExpire: live_opts.onExpire } : {})
				},
				err_shim,
				''
			);
		} else if (render_mode === 'deferred') {
			attrs.set('defer', wake_val ?? 'load');
		} else if (wake_val != null) {
			attrs.set('hydrate', wake_val);
		}
		if (from_preset && !attrs.has('hydrate') && !attrs.has('defer')) {
			throw fail(
				`${import_keys.preset} '${from_preset}' must set \`${import_keys.render}\` or \`${import_keys.wake}\` — a margin-only (or empty) preset is a no-op.`
			);
		}

		for (const k of attrs.keys()) {
			if (!ATTR_SCHEMA.has(k)) {
				throw fail(from_preset ? `unknown key \`${k}\` in preset '${from_preset}'.` : `unknown import attribute \`${k}\`.`);
			}
		}
		if (remount_opt && attrs.get('hydrate') !== 'none') {
			throw fail(`\`remount\` is only valid with \`${import_keys.wake}: 'none'\`.`);
		}

		// `defer` → SERVER island (content-only hole, fetched on the `wake` schedule).
		if (attrs.has('defer')) {
			const dval = attrs.get('defer')!;
			let when: string;
			if (KNOWN_STRATEGIES.has(dval)) when = dval;
			else if (is_media_query(dval)) when = dval;
			else
				throw fail(
					`\`${import_keys.render}: 'deferred'\` fetches on the \`${import_keys.wake}\` schedule, but '${dval}' is not one. Use \`${import_keys.wake}: 'load' | 'idle' | 'visible'\` or a media query (not 'none'/'interaction' — a hole must fetch).`
				);
			const options: { when: string; margin?: string; cacheTtlSec?: number } = { when };
			if (when === 'visible') options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
			if (live_opts.maxAge != null) {
				const ttl = parse_cache_ttl_sec(live_opts.maxAge, err_shim, '');
				if (ttl != null && ttl > 0) options.cacheTtlSec = ttl;
			}
			return { strategy: 'server', options };
		}

		if (attrs.has('hydrate')) {
			const val = attrs.get('hydrate')!;
			if (val === 'none') {
				// A LAKE (render: page, hydrate: none) — a frozen region inside a hydrated island.
				const lake_opts: { remount?: string; when?: string; margin?: string; maxAgeMs?: number; onExpire?: string } = {};
				if (remount_opt) {
					lake_opts.remount = remount_opt.policy;
					if (remount_opt.when) lake_opts.when = remount_opt.when;
					if (remount_opt.maxAgeMs != null) lake_opts.maxAgeMs = remount_opt.maxAgeMs;
					if (remount_opt.onExpire) lake_opts.onExpire = remount_opt.onExpire;
					if (remount_opt.policy === 'swr' && remount_opt.when === 'visible') {
						lake_opts.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
					}
				}
				return { strategy: 'lake', options: lake_opts };
			}
			if (val === 'false') {
				throw fail(
					`\`${import_keys.wake}: 'false'\` is not valid — use \`${import_keys.wake}: 'none'\` for a lake (a frozen region inside a hydrated island). See DESIGN.md.`
				);
			}
			let strategy: string;
			if (HYDRATE_STRATEGIES.has(val)) strategy = val;
			else if (is_media_query(val)) strategy = val;
			else
				throw fail(
					`unknown ${import_keys.wake} strategy '${val}'. Use 'load' | 'idle' | 'visible' | 'interaction' | a media query.`
				);
			const options: { margin?: string; keep?: string } = {};
			if (strategy === 'visible') options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
			if (attrs.has('keep')) {
				const p = String(attrs.get('keep')).trim();
				if (!p) throw fail(`\`keep\` needs a non-empty name (e.g. keep: 'player').`);
				options.keep = p;
			}
			return { strategy, options };
		}
		return null; // a render/wake combo that produced nothing actionable
	};

	for (const node of instance_body) {
		if (node.type !== 'ImportDeclaration') continue;
		const cleaned = clean_import_text(source, node);
		for (const spec of node.specifiers) imports.set(spec.local.name, { node, cleaned });

		const attr_list = (node.attributes ?? []).filter((a) => a.type === 'ImportAttribute');
		if (attr_list.length === 0) continue;

		/** @type {Map<string,string>} raw inline attributes */
		const inline = new Map();
		for (const a of attr_list) inline.set(a.key.name ?? a.key.value, String(a.value.value));
		const names = node.specifiers.map((sp) => sp.local.name).join(', ');

		// One parser for the whole region option surface (shared with asRegion) → the mark.
		const mark = resolve_region_mark(inline, (m) => err(names, m));
		if (!mark) continue; // a plain import attribute we don’t claim
		for (const spec of node.specifiers) marked_components.set(spec.local.name, mark);
	}

	// ── import.meta.og.asRegion(Comp, timing) — barrel / named-import placed islands ─────────────
	// The macro alternative to `import X from '…' with { wake }`: mark ANY imported component — named
	// or default, including a barrel re-export the import-attribute form can't reach — as a placed
	// island. `const Local = import.meta.og.asRegion(Comp, 'load')`. It feeds the SAME island pipeline
	// as a marked import; the only twist is the entry/wrapper import the component by its EXPORT NAME,
	// and region identity keys on `source#exportName` (so two named exports of one barrel are distinct
	// islands, not a collision). Rewritten below to a hoisted `import Local from '<binding>'`.
	const as_err = (local, msg) =>
		new Error(`[ogygia] ${rel_host}: import.meta.og.asRegion (${local}) — ${msg}`);
	const synthetic_export = new Map<string, string | undefined>(); // asRegion local -> export name

	/** Read asRegion's options object into the same key→value map an import attribute produces, so the
	 *  SHARED parser gives asRegion EXACTLY the import-attribute option surface. Object-only and
	 *  string-valued — the same shape as a `with { … }` clause. */
	const as_region_inline = (arg, local) => {
		if (!arg || arg.type !== 'ObjectExpression') {
			throw as_err(
				local,
				`needs an options object — \`import.meta.og.asRegion(Comp, { wake: 'load' })\`, the same shape as \`with { … }\`.`
			);
		}
		const inline = new Map<string, string>();
		for (const p of arg.properties ?? []) {
			if (p.type !== 'Property' || p.computed)
				throw as_err(local, 'options must be a plain object of string-valued keys.');
			const key = p.key?.name ?? p.key?.value;
			if (p.value?.type !== 'Literal' || typeof p.value.value !== 'string')
				throw as_err(local, `option \`${key}\` must be a string literal (region options are string-valued, exactly like an import attribute).`);
			inline.set(String(key), String(p.value.value));
		}
		return inline;
	};

	const as_regions: Array<{ local: string; compLocal: string; node: { start: number; end: number } }> = [];
	const as_region_nodes = new Set(); // the const statements, overwritten via their synthetic import
	for (const node of instance_body) {
		if (node.type !== 'VariableDeclaration') continue;
		const hits = node.declarations.filter(
			(d) => d.init?.type === 'CallExpression' && is_import_meta_og(d.init.callee, 'asRegion')
		);
		if (hits.length === 0) continue;
		// It rewrites to a hoisted import binding spanning the whole statement, so the shape is fixed:
		// exactly one `const` binding per asRegion statement.
		if (node.kind !== 'const')
			throw as_err(
				node.declarations[0]?.id?.name ?? '?',
				`asRegion must be bound with \`const\` (not \`${node.kind}\`) — it compiles to an import binding.`
			);
		if (node.declarations.length !== 1)
			throw as_err(
				node.declarations[0]?.id?.name ?? '?',
				'declare one asRegion per `const X = import.meta.og.asRegion(…)` statement.'
			);
		const decl = node.declarations[0];
		if (decl.id?.type !== 'Identifier') throw as_err('?', 'must bind to a plain `const Name = …`.');
		const local = decl.id.name;
		const call_args = decl.init.arguments ?? [];
		const comp_arg = call_args[0];
		if (!comp_arg || comp_arg.type !== 'Identifier')
			throw as_err(local, 'the first argument must be a component you imported (a bare identifier).');
		// Already an island via an import attribute — one mechanism per component, not both.
		if (marked_components.has(comp_arg.name))
			throw as_err(
				local,
				`'${comp_arg.name}' is already marked an island with an import attribute (\`with { … }\`). Use the import attribute OR asRegion, not both.`
			);
		const info = imports.get(comp_arg.name);
		if (!info)
			throw as_err(
				local,
				`'${comp_arg.name}' is not an imported component — import it first (e.g. \`import { ${comp_arg.name} } from './…'\`).`
			);
		const binding = import_binding_of(info.node, comp_arg.name);
		if (!binding || 'namespace' in binding)
			throw as_err(local, `'${comp_arg.name}' must be a default or named import, not a namespace import.`);
		// SAME parser as `with { … }` → exactly the same option surface, no more no less.
		const mark = resolve_region_mark(as_region_inline(call_args[1], local), (m) => as_err(local, m));
		if (!mark) throw as_err(local, 'needs a `wake`, `render`, `region`, or `preset` option.');

		// Register as a SYNTHETIC default-import: a fake ImportDeclaration spanning the `const` statement
		// (so the main region loop's rewrite replaces the const with the binding import) whose source is
		// the barrel spec (componentPath resolves normally). The named export rides in `synthetic_export`.
		// The one region loop then handles EVERY strategy — wake / render / lake / raw — identically to a
		// real import attribute; only the entry/wrapper import the component by its export name, and
		// identity keys on `source#exportName`.
		imports.set(local, {
			node: {
				start: node.start,
				end: node.end,
				type: 'ImportDeclaration',
				source: { value: binding.source },
				specifiers: [{ type: 'ImportDefaultSpecifier', local: { name: local } }],
				attributes: []
			},
			cleaned: ''
		});
		marked_components.set(local, mark);
		synthetic_export.set(local, binding.exportName);
		as_regions.push({ local, compLocal: comp_arg.name, node });
		as_region_nodes.add(node);
	}

	// TOP-LEVEL ONLY. Any other `import.meta.og.asRegion(…)` — nested in a loop / function / block /
	// larger expression, or in `<script module>`, or in markup — can't become a hoisted import, so
	// reject it loudly rather than leave the macro to crash at runtime. (Legal calls live inside the
	// `as_region_nodes` statements, which are skipped here.)
	const find_stray_as_region = (node) => {
		if (!node || typeof node !== 'object') return null;
		if (Array.isArray(node)) {
			for (const n of node) {
				const hit = find_stray_as_region(n);
				if (hit) return hit;
			}
			return null;
		}
		if (node.type === 'CallExpression' && is_import_meta_og(node.callee, 'asRegion')) return node;
		for (const k in node) {
			if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'parent') continue;
			const v = node[k];
			if (v && typeof v === 'object') {
				const hit = find_stray_as_region(v);
				if (hit) return hit;
			}
		}
		return null;
	};
	for (const place of [
		...instance_body.filter((n) => !as_region_nodes.has(n)),
		...module_body,
		...(ast.fragment?.nodes ?? [])
	]) {
		const stray = find_stray_as_region(place);
		if (stray) {
			const arg = stray.arguments?.[0];
			throw as_err(
				arg?.type === 'Identifier' ? arg.name : '?',
				'must be a top-level `const Name = import.meta.og.asRegion(Comp, timing)` in the instance <script> — ' +
					'it compiles to a hoisted import, so it can never sit inside a loop, function, block, larger ' +
					'expression, `<script module>`, or markup.'
			);
		}
	}

	// No islands here, but a `{#snippet}` may still need making portable (forwarded into an island by
	// the component it's handed to). Keep going for those; the island passes below no-op with an empty
	// `marked_components`, and the end guard returns `null` unchanged if no portable work happens.
	// A csr=false route host still carries the reset marker even with no island/snippet work.
	if (marked_components.size === 0 && as_regions.length === 0 && !source.includes('{#snippet')) {
		return needs_csr_reset ? inject_csr_reset(source, id, ast) : null;
	}

	/** Walk AST for Identifier / Component references to `local`. */
	const ast_refs_local = (root, local) => {
		let found = false;
		const walk = (node) => {
			if (found || !node || typeof node !== 'object') return;
			if (node.type === 'Identifier' && node.name === local) {
				found = true;
				return;
			}
			if (node.type === 'Component') {
				const n = node.name || '';
				if (n === local || n.startsWith(local + '.')) {
					found = true;
					return;
				}
			}
			for (const k of Object.keys(node)) {
				if (k === 'start' || k === 'end' || k === 'loc') continue;
				const v = node[k];
				if (Array.isArray(v)) for (const c of v) walk(c);
				else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
			}
		};
		if (Array.isArray(root)) for (const n of root) walk(n);
		else walk(root);
		return found;
	};
	const marked_import_referenced = (local) => {
		for (const n of instance_body) {
			if (n.type === 'ImportDeclaration') continue;
			if (ast_refs_local(n, local)) return true;
		}
		for (const n of module_body) {
			if (n.type === 'ImportDeclaration') continue;
			if (ast_refs_local(n, local)) return true;
		}
		return ast_refs_local(ast.fragment?.nodes ?? [], local);
	};

	/** Non-fallback children on a hydrate/defer call site cannot cross devalue — reject. */
	const assert_portable_children = (node, local, is_server) => {
		const kids = (node.fragment?.nodes ?? []).filter(
			(n) => !(n.type === 'Text' && !String(n.data ?? '').trim())
		);
		if (kids.length === 0) return;
		const only_fallback =
			is_server &&
			kids.length === 1 &&
			kids[0].type === 'SnippetBlock' &&
			kids[0].expression?.name === 'ogygiaFallback';
		if (only_fallback) return;
		throw new Error(
			`[ogygia] ${rel_host}: <${local}> has host children/snippets that cannot cross the island boundary. ` +
				`Under portable bindings, pass serializable props and put UI inside the island component` +
				(is_server
					? ` (only the reserved \`{#snippet ogygiaFallback()}\` may appear at the call site).`
					: `.`)
		);
	};

	let has_island_children = false;
	const visit_usages = (nodes) => {
		for (const node of nodes ?? []) {
			if (node.type === 'Component') {
				const name = node.name || '';
				if (name.includes('.')) {
					const root = name.split('.')[0];
					if (marked_components.has(root) && marked_components.get(root).strategy !== 'lake') {
						throw new Error(
							`[ogygia] ${rel_host}: dotted tag \`<${name}>\` is not supported for region import '${root}'. ` +
								`Import the leaf component with \`with { hydrate|defer }\` instead.`
						);
					}
				} else if (marked_components.has(name)) {
					const mark = marked_components.get(name);
					if (mark.strategy === 'lake') {
						if (mark.options?.remount === 'swr') assert_swr_lake_crossable(node, err);
					} else if (mark.strategy === 'server' || mark.strategy === 'held') {
						// Server islands render in isolation from serialized props (only the reserved
						// fallback snippet crosses); held regions are minted as data. Snippets can't cross either.
						assert_portable_children(node, name, mark.strategy === 'server');
					} else {
						// A hydrate island WITH real children crosses them as an OgygiaS slot pointer —
						// the app's runtime must carry the wire revivers. Surfaced for the plugin's
						// usage-gated `wire` detection (a childless minimal app stays lean).
						const kids = (node.fragment?.nodes ?? []).filter(
							(n) => !(n.type === 'Text' && !String(n.data ?? '').trim())
						);
						if (kids.length) has_island_children = true;
					}
					// Hydrate-island children need NO compile-time handling: the wrapper forwards them to
					// Region as its slot, the server renders them IN-PLACE inside a `<ogygia-slot>` marker,
					// and the payload carries a slot POINTER the client revives into an adopting snippet
					// (see region-snippet.ts). Nested islands inside render as full regions and wake on
					// their own. This is the single crossing path — the per-usage "child synth" is gone.
				}
			}
			// `CHILD_KEYS` already includes `fragment`, so this one loop covers a Component's children.
			// A separate explicit `visit_usages(node.fragment.nodes)` for Components re-descended the
			// SAME subtree a second time — for NESTED island components that doubled the work per level,
			// i.e. O(2^depth) (measured: depth-18 ≈ 62ms, depth-25 hangs). One traversal, once.
			for (const k of CHILD_KEYS) if (node[k]?.nodes) visit_usages(node[k].nodes);
		}
	};
	visit_usages(ast.fragment?.nodes ?? []);

	const s = new MagicString(source);
	/** @type {Map<string, object>} dedupe by region id within this host */
	const islands_by_id = new Map();
	const salt = ctx.idSalt || '';
	const wrapperPathFor =
		typeof ctx.wrapperPathFor === 'function'
			? ctx.wrapperPathFor
			: (_host, iid) => wrapperVirtualId(iid);

	const posix_rel = (abs) => path.relative(ctx.root, abs).split(PATH_SEP).join('/');

	// Region-identity path for a component: filesystem components key on their root-relative posix
	// path; a package specifier IS its own identity (already stable + posix, and identical across
	// hosts — so two hosts marking the same package import share one region id).
	const component_identity = (p) => (path.isAbsolute(p) ? posix_rel(p) : p);

	// Hydrate `emitFile` / `import(entry)` target — JS re-export of the real component.
	// Unique per region id so two strategies sharing one Comp keep distinct entry modules
	// (Rolldown must not content-dedupe them into a facade that drops `export default`).
	// Scale: same path+strategy → one id → one emitFile; N instances share this URL.
	// Wrappers are NOT this entry — they are SSR/csr=true host bindings only.
	const entry_source_for = (componentPath, iid, exportName) =>
		island_entry_source(componentPath, iid, exportName);

	const hydrate_wrapper_source = (iid, componentPath, entryPath, strategy, options, exportName) =>
		island_wrapper_source(
			iid,
			componentPath,
			entryPath,
			strategy,
			options,
			exportName,
			ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid),
			lang
		);

	const server_wrapper_source = (iid, componentPath, entryPath, options, exportName) => {
		const deferred_hydrate = !!options?.hydrate;
		const fetch_when = options?.when || 'load';
		let server_attrs = `__defer={${JSON.stringify(fetch_when)}}`;
		if (options?.margin != null) server_attrs += ` __margin={${JSON.stringify(options.margin)}}`;
		// Signed at mint into the hole's endpoint → the handle answers `private, max-age=cacheTtlSec`.
		if (options?.cacheTtlSec != null) server_attrs += ` __cacheTtl={${JSON.stringify(options.cacheTtlSec)}}`;
		if (deferred_hydrate) {
			const module_url = ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid);
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
	};

	const lake_wrapper_source = (iid, componentPath, options, exportName) => {
		const remount = options?.remount || 'cache';
		const needs_endpoint = remount === 'swr';
		const when = options?.when || (needs_endpoint ? 'load' : undefined);
		let attrs =
			`__entry={${JSON.stringify(iid)}} __remount={${JSON.stringify(remount)}}`;
		if (options?.maxAgeMs != null) attrs += ` __maxAge={${JSON.stringify(options.maxAgeMs)}}`;
		if (options?.onExpire) attrs += ` __onExpire={${JSON.stringify(options.onExpire)}}`;
		if (needs_endpoint) {
			attrs += ` __when={${JSON.stringify(when || 'load')}} __props={__props}`;
			if (options?.margin != null) attrs += ` __margin={${JSON.stringify(options.margin)}}`;
		}
		// Static `<OgygiaLakeInner>` (not dynamic) preserves LAKE-ENVELOPE. Client build swaps
		// that import for the render-nothing stub. Region's lake branch degrades in the shell (!isNested).
		return (
			`<script${lang}>\n` +
			`\timport { Region as OgygiaRegion__Wrapper } from 'ogygia/internal';\n` +
			`\t${component_import_line('OgygiaLakeInner', componentPath, exportName)}\n` +
			`\tlet __props = $props();\n` +
			`</script>\n` +
			`<OgygiaRegion__Wrapper __mode="lake" ${attrs}>` +
			`<OgygiaLakeInner {...__props} /></OgygiaRegion__Wrapper>\n`
		);
	};

	// Portable binding target for this compile:
	//   - SSR / csr=true client → real wrapper (Island shell + __component link)
	//   - csr=false client → stub (page node must not pull N wrappers into the client graph;
	//     emitFile owns hydrate entries; runtime loads via import(entry))
	const link_virtual = ctx.linkVirtualIsland !== false;
	const binding_stub =
		typeof ctx.clientBindingStub === 'string' && ctx.clientBindingStub
			? ctx.clientBindingStub
			: CLIENT_BINDING_STUB;

	// Rewrite each marked import binding → wrapper or stub (islands still deduped by identity).
	const rewritten_import_nodes = new Set();
	/** Entry module specs already emitted as side-effect CSS imports on this host. */
	const fouc_css_specs = new Set();

	/**
	 * csr=false CLIENT: stub replaces the portable wrapper binding, but Kit only links CSS from
	 * the *client* page graph. Side-effect-import `virtual:ogygia/fouc-css/<entry>` (CSS graph
	 * only — not the component JS) so stylesheets still ship without dual-owning the module
	 * that emitFile registers as `og-region.*`.
	 */
	const binding_rewrite = (local, bindingPath, componentPathAbs) => {
		let text = `import ${local} from ${JSON.stringify(bindingPath)};`;
		// fouc-css needs a real on-disk path (its virtual id is root-relative); a PACKAGE-specifier
		// component skips it — its styles are global package CSS (e.g. a theme.css import), not a
		// root-relative scoped stylesheet the fouc virtual could read.
		if (
			!link_virtual &&
			typeof componentPathAbs === 'string' &&
			componentPathAbs &&
			path.isAbsolute(componentPathAbs) &&
			!fouc_css_specs.has(componentPathAbs)
		) {
			fouc_css_specs.add(componentPathAbs);
			const rel = posix_rel(componentPathAbs);
			text += `\nimport ${JSON.stringify(foucCssVirtualId(rel))};`;
		}
		return text;
	};

	// Names declared at the top of the host `<script>` — used to tell a captured host VALUE (serialize
	// it) apart from a host IMPORT (re-import it into the synth) and a global (leave it alone).
	const host_declared = new Set<string>();
	const collect_pattern_names = (pat) => {
		if (!pat) return;
		if (pat.type === 'Identifier') host_declared.add(pat.name);
		else if (pat.type === 'ObjectPattern') for (const p of pat.properties ?? []) collect_pattern_names(p.value ?? p.argument);
		else if (pat.type === 'ArrayPattern') for (const e of pat.elements ?? []) collect_pattern_names(e);
		else if (pat.type === 'RestElement') collect_pattern_names(pat.argument);
		else if (pat.type === 'AssignmentPattern') collect_pattern_names(pat.left);
	};
	for (const node of instance_body) {
		if (node.type === 'VariableDeclaration') for (const d of node.declarations) collect_pattern_names(d.id);
		else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
			if (node.id?.name) host_declared.add(node.id.name);
		}
	}

	// Children of a hydrate island need NO compile-time crossing (the old per-usage "child synth"
	// is gone): the wrapper forwards them to Region as its slot, the server renders them IN-PLACE
	// inside a `<ogygia-slot>` marker, and the payload carries a slot POINTER the client revives into
	// an adopting snippet (region-snippet.ts). Nested islands inside render as full regions (see
	// SlotBoundary.svelte) and wake independently.

	for (const [local, mark] of marked_components) {
		const info = imports.get(local);
		if (!info) continue;

		if (!marked_import_referenced(local)) {
			// Unused marked import — strip entirely (dead code).
			if (!rewritten_import_nodes.has(info.node)) {
				imports_to_strip.add(info.node);
			}
			continue;
		}

		const entry_spec = info.node.source?.value;
		const componentPath = resolve_component_path(entry_spec, id, ctx);
		if (!componentPath) {
			throw new Error(
				`[ogygia] ${rel_host}: region import '${local}' needs a module specifier ($lib/…, relative, or a package specifier like 'pkg/component').`
			);
		}
		// asRegion regions ride in as a synthetic default-import; `exportName` is the barrel export the
		// generators pull (entry/wrapper import `{ Name as … }`), and identity keys on `source#exportName`.
		const exportName = synthetic_export.get(local);
		const comp_rel = component_identity(componentPath);
		const id_base =
			exportName && exportName !== 'default' ? `${comp_rel}#${exportName}` : comp_rel;
		const identity = regionIdentity(id_base, mark);
		const iid = regionId(identity, salt);
		const entryPath = ctx.virtualPathFor(id, iid);
		const wrapPath = wrapperPathFor(id, iid);
		const bindingPath = link_virtual ? wrapPath : binding_stub;

		if (mark.strategy === 'lake') {
			if (!islands_by_id.has(iid)) {
				const remount = mark.options?.remount || 'cache';
				const swr = remount === 'swr';
				islands_by_id.set(iid, {
					id: iid,
					// SWR lakes need a server-renderable entry; cache/empty are wrapper-only.
					virtualPath: swr ? entryPath : undefined,
					source: swr ? entry_source_for(componentPath, iid, exportName) : undefined,
					wrapperPath: wrapPath,
					wrapperSource: lake_wrapper_source(iid, componentPath, mark.options, exportName),
					hostPath: id,
					componentPath,
					server: swr,
					kind: 'lake',
					lakes: ['OgygiaLakeInner'],
					identity
				});
			}
			if (!rewritten_import_nodes.has(info.node)) {
				s.overwrite(
					info.node.start,
					info.node.end,
					binding_rewrite(local, bindingPath, componentPath)
				);
				rewritten_import_nodes.add(info.node);
			}
			continue;
		}

		// HELD region (`region: 'raw'`): a marked import handed to `region()`, never placed. Its binding
		// becomes a metadata descriptor `region()` reads to mint a signed capability (SSR leg carries the
		// signer; the client leg is metadata-only, so no server code reaches the browser). It bakes no
		// schedule — the `region()` call sets it (via its `(data) => options` arg). In a `.svelte` host a
		// `wake:` mark is always a WRAPPER (placed directly or via a portable binding); to bake a schedule
		// on a held region, mark it in the `.ts` registry / remote where it lives (see transformTsRegions).
		if (mark.strategy === 'held') {
			if (!islands_by_id.has(iid)) {
				islands_by_id.set(
					iid,
					make_region_binding({
						iid,
						componentPath,
						entryPath,
						hostPath: id,
						moduleUrl: ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid),
						exportName,
						identity
					})
				);
			}
			if (!rewritten_import_nodes.has(info.node)) {
				const specs = info.node.specifiers ?? [];
				if (specs.length !== 1 || specs[0].type !== 'ImportDefaultSpecifier') {
					throw err(
						local,
						`held-region imports must be a default import (\`import X from '…' with { ${import_keys.region}: 'raw' } \`).`
					);
				}
				s.overwrite(
					info.node.start,
					info.node.end,
					`import ${local} from ${JSON.stringify(regionBindingVirtualId(iid))};`
				);
				rewritten_import_nodes.add(info.node);
			}
			continue;
		}

		const is_server = mark.strategy === 'server';
		const deferred_hydrate = is_server && !!mark.options?.hydrate;
		// A `wake` island is ALSO holdable: its binding attaches a descriptor onto the wrapper so
		// `region(C)` respects the baked wake (and portable/dynamic `<C/>` still renders it). Server
		// (deferred) and lake islands are placement-only. The attach binding is the leg-split module the
		// host imports (SSR carries the signer; client is metadata) — see `wrapper_attach_binding`.
		// A `wake` island is ALSO holdable: its binding attaches the descriptor onto the wrapper so
		// `region(C)` respects the baked wake AND `<C/>` renders it. Server (deferred) islands are
		// placement-only. The wake record — mountable + holdable — is minted by the ONE shared emitter
		// `make_wake_island`, so a `.svelte` and a `.ts` `wake:` are byte-identical.
		const wants_attach = !is_server;
		if (!islands_by_id.has(iid)) {
			islands_by_id.set(
				iid,
				is_server
					? {
							id: iid,
							virtualPath: entryPath,
							wrapperPath: wrapPath,
							wrapperSource: server_wrapper_source(iid, componentPath, entryPath, mark.options, exportName),
							source: entry_source_for(componentPath, iid, exportName),
							hostPath: id,
							componentPath,
							server: true,
							kind: deferred_hydrate ? 'hydrate' : 'defer',
							lakes: [],
							identity,
							strategy: mark.strategy,
							fetchWhen: mark.options?.when,
							wakeAfter: deferred_hydrate ? mark.options?.hydrate : undefined,
							keep: mark.options?.keep
						}
					: make_wake_island({
							iid,
							componentPath,
							entryPath,
							wrapperPath: wrapPath,
							moduleUrl: ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid),
							strategy: mark.strategy,
							options: mark.options,
							exportName,
							hostPath: id,
							identity,
							lang
						})
			);
		}

		if (!rewritten_import_nodes.has(info.node)) {
			// One ImportDeclaration may have multiple specifiers — only default-import style is supported.
			const specs = info.node.specifiers ?? [];
			if (specs.length !== 1 || specs[0].type !== 'ImportDefaultSpecifier') {
				throw err(
					local,
					`region imports must be a default import (\`import X from '…' with { … }\`).`
				);
			}
			// SSR / csr=true client: import the attach binding (wake) or the bare wrapper (server/lake).
			// csr=false client: the stub (binding_rewrite handles that — link_virtual is false there).
			const rewrite_path =
				wants_attach && link_virtual ? regionBindingVirtualId(iid) : bindingPath;
			s.overwrite(
				info.node.start,
				info.node.end,
				binding_rewrite(local, rewrite_path, componentPath)
			);
			rewritten_import_nodes.add(info.node);
		}
	}

	// ── asRegion barrel-import cleanup ───────────────────────────────────────────────────────────
	// asRegion regions are emitted by the ONE region loop above (each rode in as a synthetic
	// default-import, so every strategy — wake / render / lake / raw — is handled identically). Here
	// we only strip the ORIGINAL barrel import when every specifier it declared was consumed by
	// asRegion and used nowhere else — so the HOST chunk never pulls the barrel (the island entry
	// imports the component itself, tree-shaken by the barrel).
	const as_region_locals = new Set(as_regions.map((r) => r.compLocal));
	// Strip a component's import when EVERY specifier was consumed by asRegion and used nowhere else.
	if (as_region_locals.size) {
		const referenced_outside = (local) => {
			for (const n of instance_body) {
				if (n.type === 'ImportDeclaration' || as_region_nodes.has(n)) continue;
				if (ast_refs_local(n, local)) return true;
			}
			for (const n of module_body) {
				if (n.type === 'ImportDeclaration') continue;
				if (ast_refs_local(n, local)) return true;
			}
			return ast_refs_local(ast.fragment?.nodes ?? [], local);
		};
		const seen = new Set();
		for (const compLocal of as_region_locals) {
			const info = imports.get(compLocal);
			if (!info || seen.has(info.node)) continue;
			seen.add(info.node);
			const specs = info.node.specifiers ?? [];
			const all_dead = specs.every(
				(sp) => as_region_locals.has(sp.local.name) && !referenced_outside(sp.local.name)
			);
			if (all_dead && !rewritten_import_nodes.has(info.node)) imports_to_strip.add(info.node);
		}
	}

	for (const node of imports_to_strip) {
		if (rewritten_import_nodes.has(node)) continue;
		s.remove(node.start, node.end);
	}

	// ── Portable snippets — the compiler's ONE snippet job: LIVE-branding ───────────────────────
	// A named `{#snippet}` handed to a component that may carry it across an island boundary — a
	// PLAIN component (which may forward it into an island) or a hydrate ISLAND call site directly —
	// can't cross as a function. Compile its body into a standalone island ENTRY and rewrite it to
	// `og_portable(Entry, captures, url)` (see region-snippet.ts): it renders inline in the same graph
	// AND carries a serializable descriptor, so the crossing swaps in the descriptor and the client
	// side comes ALIVE. Parameterized snippets cross too — call-time args ride the descriptor's
	// `__ogArgs` prop. Server/held/lake call sites are excluded (their children can't cross at all);
	// snippets nested inside another portable snippet ship in the outer entry and are re-processed
	// when THAT entry is transformed. Everything else (default children, bare content) is the
	// runtime's job: static freeze or slot adoption.
	const OG_PORTABLE = '__og_portable';
	const portable_candidates: Array<{ comp: { start: number; name: string }; snip }> = [];
	// SCOPE (load-bearing): branding a snippet at its definition site makes every render of it an
	// ISOLATED app — `getContext` inside the body can no longer see the surrounding tree. So brand
	// ONLY where crossing is genuinely required, never where plain Svelte semantics must hold:
	//  - a PLAIN component site takes 0-ARG snippets only (the may-be-forwarded-into-an-island case;
	//    parameterized snippets there are internal wiring — think Bits UI passing `{#snippet x(props)}`
	//    between its own context-coupled components — and MUST stay native);
	//  - a hydrate-ISLAND call site takes ANY arity (without branding the snippet would freeze wrong);
	//  - LIBRARY code (node_modules, swept into the transform by the island-graph seam) is never
	//    branded at all — its snippets were authored against plain Svelte.
	const portable_allowed = !id.includes('node_modules');
	const walk_portable = (nodes) => {
		for (const node of nodes ?? []) {
			if (node.type === 'Component') {
				const base_name = String(node.name || '').split('.')[0];
				const mark = marked_components.get(base_name);
				const island_site = !!mark && !['lake', 'server', 'held'].includes(mark.strategy);
				// GENERATED-OUTPUT GUARD (load-bearing): a component imported from one of ogygia's own
				// virtuals (the client-binding stub, a wrapper/island/region module) means this source
				// is ALREADY-TRANSFORMED output — its mark was consumed, so it reads as "plain" here.
				// Branding its snippets would mint a PHANTOM portable island whose registration wipes
				// the host's real wrapper entries (the csr=false server-island prerender crash). A
				// re-transform of generated output must never widen the island set.
				const import_spec = String(imports.get(base_name)?.node?.source?.value ?? '');
				const from_generated = import_spec.startsWith('virtual:ogygia/');
				for (const child of node.fragment?.nodes ?? []) {
					if (child.type !== 'SnippetBlock' || !child.expression?.name) continue;
					const zero_arg = (child.parameters?.length ?? 0) === 0;
					if (island_site || (!mark && zero_arg && !from_generated)) {
						portable_candidates.push({ comp: node, snip: child });
					}
				}
			}
			for (const k of CHILD_KEYS) if (node[k]?.nodes) walk_portable(node[k].nodes);
		}
	};
	if (portable_allowed) walk_portable(ast.fragment?.nodes ?? []);

	// Drop snippets nested inside another candidate's body — that content ships in the outer entry and
	// is re-processed when the entry `.svelte` is transformed, so converting it here would double-edit.
	const outer_candidates = portable_candidates.filter(
		(c) =>
			!portable_candidates.some(
				(o) => o !== c && c.snip.start >= o.snip.start && c.snip.end <= o.snip.end
			)
	);

	let portable_emitted = false;
	const portable_imports: string[] = [];
	const portable_seen = new Set<string>();
	for (const { comp, snip } of outer_candidates) {
		const name = snip.expression.name;
		const body = snip.body?.nodes ?? [];
		if (!body.length) continue;
		// Snippet PARAMETERS are call-time inputs, not captures: the entry receives them as an
		// `__ogArgs` prop (region-snippet.ts threads call args into it) and re-binds them verbatim.
		const snip_params = snip.parameters ?? [];
		const params_src = snip_params.length
			? source.slice(snip_params[0].start, snip_params[snip_params.length - 1].end)
			: '';
		const param_names = new Set<string>();
		const collect_param_names = (n) => {
			if (!n || typeof n !== 'object') return;
			if (Array.isArray(n)) return n.forEach(collect_param_names);
			if (n.type === 'Identifier' && n.name) param_names.add(n.name);
			for (const k in n) {
				if (k === 'type' || k === 'start' || k === 'end') continue;
				const v = n[k];
				if (v && typeof v === 'object') collect_param_names(v);
			}
		};
		collect_param_names(snip_params);
		const { free, mutated } = collectCaptureInfo(body);
		// Only a HOST-state write disqualifies branding (a captured snapshot can't write back). A snippet
		// mutating its OWN parameter is fine — params ride `__ogArgs`, not a capture — so exclude them,
		// exactly as the `free` loop below does. Otherwise a snippet that only reassigns its own param was
		// wrongly left native and failed to cross as a region.
		if ([...mutated].some((m) => !param_names.has(m))) continue;
		const cleaned_imports: string[] = [];
		const seen_imports = new Set<string>();
		const captures: string[] = [];
		for (const nm of free) {
			if (param_names.has(nm)) continue; // a snippet param — rides __ogArgs, never a capture
			if (imports.has(nm)) {
				// An ISLAND placement inside the snippet body must stay an island inside the entry: emit
				// the ORIGINAL import (keeping its `with { wake: … }` attributes) so the entry's own
				// transform pass re-marks it and rewrites the placement into a region. A cleaned import
				// here silently demoted the island to a plain component (no region, no JS, and a
				// top-level await inside it crashed the sync snippet render).
				const info = imports.get(nm);
				const text = marked_components.has(nm)
					? source.slice(info.node.start, info.node.end).trim()
					: info.cleaned.trim();
				// Several captured names can resolve to the SAME statement (`{ a, b, c } from './x'`);
				// that one statement already declares all of them, so emit it ONCE. Pushing it per name
				// redeclares the identifiers in the synth ("already been declared" build error).
				if (!seen_imports.has(text)) {
					seen_imports.add(text);
					cleaned_imports.push(text);
				}
			} else if (host_declared.has(nm)) captures.push(nm);
			// else: a global — referenced directly in the entry, needs no wiring.
		}
		const markup = source.slice(body[0].start, body[body.length - 1].end);
		const hash = createHash('md5')
			.update(`${markup}\0${captures.join(',')}\0${cleaned_imports.join('\n')}\0${params_src}`)
			.digest('hex')
			.slice(0, 12);
		const identity = regionIdentity(`${rel_host}\0psnip:${hash}`, { strategy: 'hydrate' });
		const iid = regionId(identity, salt);
		const entryPath = ctx.virtualPathFor(id, iid).replace(JS_EXT, '.svelte');
		if (!islands_by_id.has(iid)) {
			const prop_names = snip_params.length ? ['__ogArgs = []', ...captures] : captures;
			const synth =
				`<script${lang}>\n` +
				`\timport 'virtual:ogygia/transportables';\n` +
				cleaned_imports.map((imp) => `\t${imp}\n`).join('') +
				(prop_names.length
					? `\t// svelte-ignore state_referenced_locally\n\tlet { ${prop_names.join(', ')} } = $props();\n`
					: '') +
				(snip_params.length
					? `\t// svelte-ignore state_referenced_locally\n\tconst [${params_src}] = __ogArgs;\n`
					: '') +
				`</script>\n` +
				markup +
				'\n';
			islands_by_id.set(iid, {
				id: iid,
				virtualPath: entryPath,
				wrapperPath: wrapperPathFor(id, iid),
				wrapperSource: '',
				source: synth,
				hostPath: id,
				componentPath: entryPath,
				server: false,
				kind: 'hydrate',
				lakes: [],
				identity,
				strategy: 'hydrate',
				portable: true
			});
		}
		const url = ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid);
		const cap_obj = captures.length ? `{ ${captures.join(', ')} }` : '{}';
		// SSR renders the entry inline (static import); the csr=false client loads it by url on wake.
		// Two identical snippets dedupe to one iid → import/preload each entry ONCE (else a duplicate
		// `__OgPS_<iid>` declaration).
		const entry_ref = ctx.ssr ? `__OgPS_${iid}` : 'null';
		if (!portable_seen.has(iid)) {
			portable_seen.add(iid);
			if (ctx.ssr) portable_imports.push(`import __OgPS_${iid} from ${JSON.stringify(entryPath)};`);
			// (No static <head> modulepreload here — that preloaded every portable CANDIDATE in the
			// host, rendered or not. The no-waterfall hint is emitted RENDER-GATED by Region.svelte
			// instead: an island whose props carry a portable descriptor preloads its entry + deps
			// alongside its own facade, so only snippets that actually cross a rendered boundary
			// cost a fetch.)
		}
		s.remove(snip.start, snip.end);
		const insert_at = comp.start + 1 + String(comp.name).length;
		s.appendLeft(
			insert_at,
			` ${name}={${OG_PORTABLE}(${entry_ref}, ${cap_obj}, ${JSON.stringify(url)})}`
		);
		portable_emitted = true;
	}

	// Instance-script head: the portable helper import, and — on a csr=false route host — the
	// csr-false RESET marker (see CSR_FALSE_INJECT). One combined injection so a script-less host
	// gains exactly ONE synthesized <script>.
	{
		let head = '';
		if (needs_csr_reset) head += CSR_FALSE_INJECT;
		if (portable_emitted) {
			head +=
				`import { og_portable as ${OG_PORTABLE} } from 'ogygia/internal';\n` +
				portable_imports.join('\n') +
				'\n';
		}
		if (head) {
			if (ast.instance) s.appendLeft(ast.instance.content.start, `\n${head}`);
			else s.prepend(`<script${lang}>\n${head}</script>\n`);
		}
	}

	// Snippet-only files that produced no island or portable work are untouched — behave as bailed.
	// (Not on a csr=false route host: the reset marker above is itself a change to keep.)
	if (!needs_csr_reset && !has_island_hint && !portable_emitted && islands_by_id.size === 0) return null;

	return {
		code: s.toString(),
		map: s.generateMap({ hires: true, source: id, includeContent: true }),
		islands: [...islands_by_id.values()],
		hasIslandChildren: has_island_children
	};
}

/** Parse a flat import-attributes clause body (`a: 'x', b: "y"`) into a key→value map. */
/**
 * Parse the flat body of an import-attributes clause (`with { a: 'x', b: "y" }`) into a map.
 * Values must be string literals (the only form ogygia marks use).
 * @param {string} raw the text between the `with {` and `}`
 * @returns {Map<string, string>}
 */
function parse_import_attrs(raw) {
	const attrs = new Map();
	const re = /([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*('[^']*'|"[^"]*")/g;
	let m;
	while ((m = re.exec(raw))) {
		const key = m[1].replace(WRAP_QUOTES, '');
		const val = m[2].slice(1, -1);
		attrs.set(key, val);
	}
	return attrs;
}

/**
 * Rewrite held-region imports in a `.ts` / `.js` module (a load or remote function, where held
 * regions are minted and handed to `region()`). Svelte's `parse()` can't read these files, so this is
 * a targeted regex pass over the (only supported) default-import form. A `.ts` module has no template,
 * so every marked import here is HELD → a descriptor. Two markers:
 *   - `region: 'raw'` → bakes no schedule (set at the `region()` call).
 *   - `wake: 'x'`     → bakes that schedule (the `region()` call can still override).
 * Each registers a server-manifest entry + client chunk and is rewritten to import the leg-split
 * descriptor module. Returns the same `{code, map, islands}` shape, or `null` when nothing matched.
 *
 * @param {string} source
 * @param {string} id absolute module path
 * @param {Object} ctx same context fields as {@link transformHost} (root, libDir, dev, devUrlFor,
 *   virtualPathFor, importKeys, idSalt, pathModule)
 * @returns {TransformResult|null}
 */
/** Byte ranges of every template/string literal AND comment in a `.ts`/`.js` source, or `null` if it
 *  doesn't parse. Used to tell a REAL held-region import from one that is only TEXT inside a code
 *  sample — whether that sample sits in a template/string literal or a JSDoc `@example` comment. */
function ts_literal_ranges(source: string, id: string): Array<[number, number]> | null {
	const { program, ok, comments } = parse_module(source, id);
	if (!ok || !program) return null;
	const ranges: Array<[number, number]> = [];
	const walk = (n: unknown): void => {
		if (!n || typeof n !== 'object') return;
		if (Array.isArray(n)) return void n.forEach(walk);
		const node = n as Record<string, unknown>;
		const t = node.type;
		const is_str = (t === 'Literal' || t === 'StringLiteral') && typeof node.value === 'string';
		if ((t === 'TemplateLiteral' || is_str) && typeof node.start === 'number' && typeof node.end === 'number') {
			ranges.push([node.start, node.end]);
		}
		for (const k in node) {
			if (k === 'type' || k === 'start' || k === 'end') continue;
			const v = node[k];
			if (v && typeof v === 'object') walk(v);
		}
	};
	walk(program);
	// Comments are trivia (not in the AST body) — a held-region import inside a JSDoc `@example` must be
	// skipped too, so add their ranges.
	for (const c of comments) {
		if (typeof c.start === 'number' && typeof c.end === 'number') ranges.push([c.start, c.end]);
	}
	return ranges;
}

/** Fallback for {@link ts_literal_ranges} when the file doesn't parse: is `pos` preceded by an odd
 *  number of unescaped backticks (i.e. inside an unterminated template literal)? */
function odd_unescaped_backticks_before(source: string, pos: number): boolean {
	let backticks = 0;
	for (let i = 0; i < pos; i++) {
		if (source[i] === '`' && source[i - 1] !== '\\') backticks++;
	}
	return backticks % 2 === 1;
}

export function transformTsRegions(source, id, ctx) {
	const import_keys = normalize_import_keys(ctx.importKeys);
	const regionKey = import_keys.region;
	const wakeKey = import_keys.wake;
	// cheap bail — a held import (`with { region|wake }`) OR the `import.meta.og.asRegion(…)` macro.
	const has_as_region = source.includes('asRegion');
	if (!has_as_region && ((!source.includes(regionKey) && !source.includes(wakeKey)) || !source.includes('with')))
		return null;

	const path = ctx.pathModule;
	const root = ctx.root;
	const salt = ctx.idSalt || '';
	const rel_host = path.relative(root, id).split(PATH_SEP).join('/');
	const posix_rel = (abs) => path.relative(root, abs).split(PATH_SEP).join('/');

	// Same policy as transformHost's resolve_component_path: $lib/relative → absolute file path,
	// anything else (package specifier / alias) is kept verbatim and re-emitted for Vite to resolve.
	const resolve_spec = (spec) => {
		if (typeof spec !== 'string' || !spec.trim()) return null;
		if (spec === '$lib' || spec.startsWith('$lib/')) {
			return path.join(ctx.libDir, spec === '$lib' ? '' : spec.slice('$lib/'.length));
		}
		if (spec.startsWith('.')) return path.resolve(path.dirname(id), spec);
		return spec;
	};
	const component_identity = (p) => (path.isAbsolute(p) ? posix_rel(p) : p);

	const wrapper_path_for = (wid: string) =>
		typeof ctx.wrapperPathFor === 'function' ? ctx.wrapperPathFor(id, wid) : wrapperVirtualId(wid);

	// The ONE `.ts`/`.js` region emitter — shared by the `with { … }` import form and the
	// `import.meta.og.asRegion(…)` macro (which additionally resolves a barrel `exportName`). A
	// `region: 'raw'` marker → a bare held descriptor; a `wake:` marker → a MOUNTABLE held island (the
	// same `make_wake_island` record the `.svelte` host uses; `held: true` so it also crosses the wire).
	// Its identity stays `held:*` — distinct from a `.svelte` PLACED island (`hydrate:*`, no endpoint).
	// Returns `{ iid, record }` for the caller to register + rewrite. `exportName` is undefined for a
	// default import, the barrel export name for a named one.
	const emit_ts_region = (
		componentPath: string,
		marker: { region?: string; wake?: string },
		exportName?: string
	): { iid: string; record: object } => {
		const comp_rel = component_identity(componentPath);
		const id_base = exportName && exportName !== 'default' ? `${comp_rel}#${exportName}` : comp_rel;
		if (marker.region != null) {
			normalize_region_value(marker.region, rel_host, regionKey);
			const identity = regionIdentity(id_base, { strategy: 'held', options: {} });
			const iid = regionId(identity, salt);
			const entryPath = ctx.virtualPathFor(id, iid);
			return {
				iid,
				record: make_region_binding({
					iid,
					componentPath,
					entryPath,
					hostPath: id,
					moduleUrl: ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid),
					exportName,
					identity
				})
			};
		}
		const strategy = normalize_hydrate_value(marker.wake as string, rel_host, wakeKey);
		const hydrateMargin =
			strategy === 'visible' && ctx.visibleMargin != null ? ctx.visibleMargin : undefined;
		const identity = regionIdentity(id_base, {
			strategy: 'held',
			options: hydrateMargin ? { hydrate: strategy, hydrateMargin } : { hydrate: strategy }
		});
		const iid = regionId(identity, salt);
		const entryPath = ctx.virtualPathFor(id, iid);
		return {
			iid,
			record: make_wake_island({
				iid,
				componentPath,
				entryPath,
				wrapperPath: wrapper_path_for(iid),
				moduleUrl: ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid),
				strategy,
				options: hydrateMargin ? { margin: hydrateMargin } : {},
				hostPath: id,
				identity,
				lang: '',
				held: true,
				exportName
			})
		};
	};

	const s = new MagicString(source);
	const islands_by_id = new Map();
	let matched = false;
	// The regex below scans RAW source, so it also matches held-region import EXAMPLES that are only
	// TEXT — a `snippets.ts` template-literal sample, or a JSDoc `@example` in a comment (ogygia's own
	// `src/index.ts` has one). A real import is a top-level statement, never inside a literal or comment,
	// so skip any match whose position falls in one. AST-accurate (byte-exact offsets); if the file
	// doesn't parse (half-typed mid-edit), fall back to the unescaped-backtick-parity heuristic.
	const literal_ranges = ts_literal_ranges(source, id);
	const inside_literal = (pos: number): boolean =>
		literal_ranges
			? literal_ranges.some(([a, b]) => pos >= a && pos < b)
			: odd_unescaped_backticks_before(source, pos);
	// Default import + import-attributes clause: `import X from '…' with { … }` (the only form).
	const re = /import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2\s+with\s*\{([^}]*)\}\s*;?/g;
	let m;
	while ((m = re.exec(source))) {
		const [full, local, , spec, attrsRaw] = m;
		const attrs = parse_import_attrs(attrsRaw);
		const has_region = attrs.has(regionKey);
		const has_wake = attrs.has(wakeKey);
		if (!has_region && !has_wake) continue;
		if (inside_literal(m.index)) continue;
		if (attrs.size > 1) {
			throw new Error(
				`[ogygia] ${rel_host}: a held-region import on '${local}' takes exactly one marker — \`${regionKey}: 'raw'\` (schedule set at the \`region()\` call) or \`${wakeKey}: '…'\` (baked schedule).`
			);
		}
		const componentPath = resolve_spec(spec);
		if (!componentPath) {
			throw new Error(
				`[ogygia] ${rel_host}: held-region import '${local}' needs a module specifier ($lib/…, relative, or a package specifier like 'pkg/component').`
			);
		}
		const { iid, record } = emit_ts_region(
			componentPath,
			has_region ? { region: attrs.get(regionKey) } : { wake: attrs.get(wakeKey) }
		);
		if (!islands_by_id.has(iid)) islands_by_id.set(iid, record);
		s.overwrite(
			m.index,
			m.index + full.length,
			`import ${local} from ${JSON.stringify(regionBindingVirtualId(iid))};`
		);
		matched = true;
	}

	// ── import.meta.og.asRegion(Comp, options) — the barrel/named escape hatch in a `.ts`/`.js` file ──
	// A `.ts` module has no template, so `asRegion` here mints a HELD binding (mountable + crossable),
	// the SAME record `emit_ts_region` makes for `with { … }` — only the component is resolved by its
	// EXPORT NAME (barrel-friendly). `const Local = import.meta.og.asRegion(Comp, { wake: 'visible' })`
	// rewrites to a hoisted `import Local from '<binding>'`. Top-level only, one const per statement.
	if (has_as_region) {
		const { program: as_program } = parse_module(source, id);
		if (as_program) {
			const body = (as_program.body ?? []) as Array<Record<string, any>>;
			const as_err = (local: string, msg: string) =>
				new Error(`[ogygia] ${rel_host}: import.meta.og.asRegion (${local}) — ${msg}`);
			// Resolve a local name → its import declaration (for source + export name).
			const import_of = new Map<string, Record<string, any>>();
			for (const node of body) {
				if (node.type !== 'ImportDeclaration') continue;
				for (const spec of node.specifiers ?? []) if (spec.local?.name) import_of.set(spec.local.name, node);
			}
			// TOP-LEVEL ONLY: reject any asRegion() not in a top-level `const X = asRegion(…)`.
			const legal_nodes = new Set<unknown>();
			for (const node of body) {
				if (node.type !== 'VariableDeclaration') continue;
				if (node.declarations.some((d: any) => d.init?.type === 'CallExpression' && is_import_meta_og(d.init.callee, 'asRegion')))
					legal_nodes.add(node);
			}
			const find_stray = (n: any): any => {
				if (!n || typeof n !== 'object') return null;
				if (Array.isArray(n)) {
					for (const x of n) {
						const hit = find_stray(x);
						if (hit) return hit;
					}
					return null;
				}
				if (n.type === 'CallExpression' && is_import_meta_og(n.callee, 'asRegion')) return n;
				for (const k in n) {
					if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'parent') continue;
					const v = n[k];
					if (v && typeof v === 'object') {
						const hit = find_stray(v);
						if (hit) return hit;
					}
				}
				return null;
			};
			for (const node of body) {
				if (legal_nodes.has(node)) continue;
				const stray = find_stray(node);
				if (stray) {
					const a = stray.arguments?.[0];
					throw as_err(
						a?.type === 'Identifier' ? a.name : '?',
						'must be a top-level `const Name = import.meta.og.asRegion(Comp, options)` — it compiles ' +
							'to a hoisted import, so it can never sit in a loop, function, block, or larger expression.'
					);
				}
			}

			for (const node of body) {
				if (!legal_nodes.has(node)) continue;
				if (node.kind !== 'const')
					throw as_err(node.declarations[0]?.id?.name ?? '?', `must be bound with \`const\` (not \`${node.kind}\`).`);
				if (node.declarations.length !== 1)
					throw as_err(node.declarations[0]?.id?.name ?? '?', 'declare one asRegion per `const` statement.');
				const decl = node.declarations[0];
				if (decl.id?.type !== 'Identifier') throw as_err('?', 'must bind to a plain `const Name = …`.');
				const local = decl.id.name;
				const call_args = decl.init.arguments ?? [];
				const comp_arg = call_args[0];
				if (!comp_arg || comp_arg.type !== 'Identifier')
					throw as_err(local, 'the first argument must be a component you imported (a bare identifier).');
				const imp = import_of.get(comp_arg.name);
				if (!imp)
					throw as_err(
						local,
						`'${comp_arg.name}' is not an imported component — import it first (e.g. \`import { ${comp_arg.name} } from './…'\`).`
					);
				const binding = import_binding_of(imp, comp_arg.name);
				if (!binding || 'namespace' in binding)
					throw as_err(local, `'${comp_arg.name}' must be a default or named import, not a namespace import.`);
				const componentPath = resolve_spec(binding.source);
				if (!componentPath) throw as_err(local, `could not resolve '${binding.source}'.`);
				// Options object: `{ wake: '…' }` or `{ region: 'raw' }` — the same `.ts` surface as `with { … }`.
				const marker = parse_ts_as_region_options(call_args[1], (msg) => as_err(local, msg), regionKey, wakeKey);
				const { iid, record } = emit_ts_region(componentPath, marker, binding.exportName);
				if (!islands_by_id.has(iid)) islands_by_id.set(iid, record);
				s.overwrite(node.start, node.end, `import ${local} from ${JSON.stringify(regionBindingVirtualId(iid))};`);
				matched = true;
			}
		}
	}

	if (!matched) return null;
	return {
		code: s.toString(),
		map: s.generateMap({ hires: true, source: id, includeContent: true }),
		islands: [...islands_by_id.values()]
	};
}
