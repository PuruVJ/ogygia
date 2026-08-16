import { parse } from 'svelte/compiler';
import MagicString from 'magic-string';
import { createHash } from 'node:crypto';
import { foucCssVirtualId } from './fouc-css.js';
import { collectCaptureInfo } from './free-vars.js';

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const PATH_SEP = /[/\\]/;
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i;
const JS_EXT = /\.js$/;
const WRAP_QUOTES = /^['"]|['"]$/g;

export { foucCssVirtualId } from './fouc-css.js';

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

/**
 * Fingerprint of a region mark for dedupe. Same component path + same key → one wrapper/entry.
 * @param {{ strategy: string, options?: Record<string, unknown> }} mark
 */
export function strategyKey(mark: { strategy: string; options?: Record<string, unknown> | null }) {
	const o = mark.options || {};
	if (mark.strategy === 'server') {
		let k = `defer:${o.when ?? 'load'}`;
		if (o.margin != null) k += `:margin:${o.margin}`;
		// Cache TTL is baked into the wrapper (it signs the endpoint), so it MUST fingerprint the
		// wrapper — else a cached hole (maxAge) dedupes onto a plain no-store wrapper of the same
		// component+schedule and silently loses its `ttl`.
		if (o.cacheTtlSec != null) k += `:ttl:${o.cacheTtlSec}`;
		if (o.hydrate) {
			k += `+hydrate:${o.hydrate}`;
			if (o.hydrateMargin != null) k += `:hmargin:${o.hydrateMargin}`;
		}
		return k;
	}
	if (mark.strategy === 'lake') {
		let k = `lake:${o.remount || 'cache'}`;
		if (o.when) k += `:when:${o.when}`;
		if (o.maxAgeMs != null) k += `:maxAge:${o.maxAgeMs}`;
		if (o.onExpire) k += `:onExpire:${o.onExpire}`;
		if (o.margin != null) k += `:margin:${o.margin}`;
		return k;
	}
	// A held region (a marked import handed to `region()`, not placed) is a server-chosen island minted
	// on demand. Its baked wake schedule IS part of the key (`region:visible` ≠ `region:raw`), and the
	// `region:` prefix keeps it distinct from a PLACED wrapper of the same component+schedule
	// (`hydrate:visible`), so a component both placed and held gets two artifacts, not a collision. It
	// always ships a client chunk (it MIGHT be woken; `region:raw` bakes no schedule → set at the call).
	if (mark.strategy === 'held') {
		let k = `region:${o.hydrate || 'raw'}`;
		if (o.hydrateMargin != null) k += `:hmargin:${o.hydrateMargin}`;
		return k;
	}
	let k = `hydrate:${mark.strategy}`;
	if (o.margin != null) k += `:margin:${o.margin}`;
	return k;
}

/**
 * Cross-host stable identity: posix component path + {@link strategyKey}.
 * Drives region ids so multiple hosts / import sites / `<A />` usages share one module.
 */
export function regionIdentity(
	componentRelPath: string,
	mark: { strategy: string; options?: Record<string, unknown> | null }
) {
	return `${String(componentRelPath).split(PATH_SEP).join('/')}\0${strategyKey(mark)}`;
}

/** Hash an identity string (optional production salt) → 12-char region id. */
export function regionId(identityKey: string, salt = '') {
	const msg = salt ? `${salt}\0${identityKey}` : identityKey;
	return createHash('md5').update(msg).digest('hex').slice(0, 12);
}

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

/** JS re-export of the real component — the held region's entry (SSR render + client hydrate). */
function region_entry_source(componentPath: string, iid: string) {
	return (
		`import __OgygiaComp_${iid} from ${JSON.stringify(componentPath)};\n` +
		`export default __OgygiaComp_${iid};\n`
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
		source: region_entry_source(opts.componentPath, opts.iid),
		bindingPath: regionBindingVirtualId(opts.iid),
		// SSR leg is DUAL-FACE: it carries the real component (so `region()` can render inline in
		// the same server pass) AND the signer (so the transport can mint a capability when the
		// held region crosses the wire). `__renderHtml` renders the component to HTML on the server when
		// the held region is awaited (live regions), so the ticket travels with its markup — no fetch.
		// `svelte/server` is imported only on this SSR leg; the client leg is metadata-only, so the
		// component and server render never ship to the browser bundle.
		bindingSsrSource:
			`import __ogRegionComp from ${JSON.stringify(opts.componentPath)};\n` +
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
}) {
	let meta = `__ogRegion: ${JSON.stringify(opts.iid)}, __module: ${JSON.stringify(opts.moduleUrl)}`;
	if (opts.hydrate) meta += `, __hydrate: ${JSON.stringify(opts.hydrate)}`;
	if (opts.hydrate && opts.hydrateMargin != null)
		meta += `, __hydrateMargin: ${JSON.stringify(opts.hydrateMargin)}`;
	return {
		ssr:
			`import __OgygiaWrap from ${JSON.stringify(opts.wrapperPath)};\n` +
			`import __ogRegionComp from ${JSON.stringify(opts.componentPath)};\n` +
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
export function transformHost(source, id, ctx) {
	const import_keys = normalize_import_keys(ctx.importKeys);
	// cheap bailout — the library only touches region imports (configured key names), PLUS files that
	// define a `{#snippet}` (a candidate portable snippet forwarded into an island). Files with a
	// snippet but no island work return `null` unchanged at the end, so behavior is identical for them.
	const has_island_hint = import_keys_hint(import_keys).test(source);
	if (!has_island_hint && !source.includes('{#snippet')) return null;

	let ast;
	try {
		ast = parse(source, { modern: true, filename: id });
	} catch {
		return null;
	}

	const instance_body = ast.instance?.content?.body ?? [];
	const module_body = ast.module?.content?.body ?? [];
	const lang = script_lang_attr(ast.instance) || script_lang_attr(ast.module);

	// csr=true route host: ogygia steps aside ENTIRELY. Kit hydrates the page's components itself, so a
	// region wrapper + runtime would be dead weight (measured: a csr=true page was shipping the whole
	// runtime for nothing). Strip every region import attribute to a plain import — Kit compiles `<C/>`
	// normally — and emit NO island, so the runtime chunk isn't pulled either. `wake` schedules become
	// immediate, which is exactly what csr=true means. (`.ts` held regions are unaffected: they cross
	// the wire and are a server-driven-UI feature, orthogonal to a page's csr.)
	if (ctx.csrTrue) {
		const region_keys = new Set([
			import_keys.wake,
			import_keys.render,
			import_keys.preset,
			import_keys.region
		]);
		const ms = new MagicString(source);
		let touched = false;
		for (const node of instance_body) {
			if (node.type !== 'ImportDeclaration') continue;
			const attrs = (node.attributes ?? []).filter((a) => a.type === 'ImportAttribute');
			if (!attrs.some((a) => region_keys.has(a.key.name ?? a.key.value))) continue;
			ms.overwrite(node.start, node.end, clean_import_text(source, node));
			touched = true;
		}
		if (!touched) return null;
		return {
			code: ms.toString(),
			map: ms.generateMap({ hires: true, source: id, includeContent: true }),
			islands: []
		};
	}

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

		// Retired `partial:` key → point at its replacement (only when it isn't the configured name).
		if (inline.has('partial') && !REGION_KEYS.includes('partial')) {
			throw err(
				names,
				`the \`partial\` import attribute was retired. Mark a held-across-a-boundary component with \`${import_keys.region}: 'raw'\` (schedule set at the \`region()\` call), or bake a schedule with a \`${import_keys.wake}:\` mark.`
			);
		}

		// Only imports carrying a REGION key are ours. A standard import attribute on an
		// UNRELATED import — `import data from './d.json' with { type: 'json' }`, an
		// `with { type: 'macro' }`, etc. — is left completely untouched (its `with{}` preserved),
		// even in a file that also declares islands. We only validate + strip the imports we claim.
		if (!REGION_KEYS.some((k) => inline.has(k))) continue;

		// `with { region: 'raw' }` — a held region a registry hands to `region()`, minted on demand.
		if (inline.has(import_keys.region)) {
			// The marker takes ONE value, `'raw'`, and carries no schedule (set at the `region()` call).
			// Must be the only import attribute.
			if (inline.size > 1) {
				throw err(
					names,
					`\`${import_keys.region}\` must be the only import attribute — it only marks a held region ('raw'); set the wake schedule at the \`region()\` call.`
				);
			}
			normalize_region_value(inline.get(import_keys.region), rel_host, import_keys.region);
			for (const spec of node.specifiers) {
				marked_components.set(spec.local.name, { strategy: 'held', options: {} });
			}
			continue;
		}

		// The import block carries a `render` MODE + a `wake` schedule, or a preset. No option keys
		// inline — all tuning lives in plugin config (ogygia({ presets })). `render` picks the mode
		// (static | deferred | live); `wake` is hydration for `static`, the fetch schedule for
		// `deferred`/`live`. Canonical internal slots stay `hydrate`/`defer` (+ a `live` flag).
		/** @type {Map<string,string>} effective attributes (canonical hydrate/defer + margin + live) */
		let attrs = new Map();
		/** @type {{ strategy: string, when?: string } | undefined} */
		let remount_opt;
		let from_preset = null;
		let render_mode; // undefined | 'static' | 'deferred' | 'live'
		let wake_val; // the schedule string (slotted by render mode below)
		/** render:'live' policy (from preset). */
		const live_opts: { revalidate?: unknown; maxAge?: unknown; onExpire?: unknown } = {};
		if (inline.has(import_keys.preset)) {
			if (inline.size > 1) {
				throw err(
					names,
					`\`${import_keys.preset}\` must be the only import attribute — put its options (margin, maxAge, …) in the preset definition (ogygia({ presets })).`
				);
			}
			from_preset = inline.get(import_keys.preset);
			const preset = ctx.presets && ctx.presets[from_preset];
			if (!preset) {
				const avail = Object.keys(ctx.presets || {});
				throw err(
					names,
					`unknown ${import_keys.preset} '${from_preset}'. Available: ${avail.length ? avail.join(', ') : '(none)'}.`
				);
			}
			for (const [k, v] of Object.entries(preset)) {
				if (v == null) continue;
				if (k === import_keys.render) render_mode = String(v);
				else if (k === import_keys.wake) wake_val = String(v);
				// `render: 'deferred'` cache + `render: 'live'` revalidate policy — resolved by mode below.
				else if (k === 'maxAge' || k === 'onExpire' || k === 'revalidate') live_opts[k] = v;
				else if (k === 'margin' || k === 'keep') attrs.set(k, String(v));
				else {
					throw err(
						names,
						`unknown key \`${k}\` in preset '${from_preset}'. Use \`${import_keys.render}\`, \`${import_keys.wake}\`, \`margin\`, \`maxAge\`, \`onExpire\`, \`revalidate\`.`
					);
				}
			}
		} else {
			// inline may carry the configured render + wake keys, and the continuity `keep` key.
			for (const k of inline.keys()) {
				if (k !== import_keys.wake && k !== import_keys.render && k !== 'keep') {
					throw err(
						names,
						`\`${k}\` is not allowed inline. Use \`${import_keys.render}\`, \`${import_keys.wake}\`, \`keep\`, or a named \`${import_keys.preset}\` — options like \`margin\` / \`maxAge\` belong in plugin config (ogygia({ presets })).`
					);
				}
			}
			if (inline.has(import_keys.render)) render_mode = inline.get(import_keys.render);
			if (inline.has(import_keys.wake)) wake_val = inline.get(import_keys.wake);
			if (inline.has('keep')) attrs.set('keep', inline.get('keep'));
		}

		// Slot `wake` by render mode. `deferred`/`live` → `wake` is the FETCH schedule (defer, defaults
		// load; content-only, never hydrates — nest a `wake` island for interactivity). `static`/absent
		// → `wake` is the HYDRATE schedule (island, or lake at `none`).
		if (render_mode != null && !RENDER_MODES.has(render_mode)) {
			throw err(
				names,
				`unknown ${import_keys.render} '${render_mode}'. Use 'static' (inline HTML) | 'deferred' (a hole, fetched) | 'live' (a hole that revalidates).`
			);
		}
		if (render_mode === 'live') {
			// `live` = baked static content that revalidates (Option A). Internally a frozen region +
			// swr revalidate: the first frame renders inline at SSR/build (prerender-friendly, instant),
			// then re-fetches from its signed endpoint when stale. `wake` is the revalidate schedule;
			// `maxAge`/`onExpire` come from the preset.
			attrs.set('hydrate', 'none');
			remount_opt = parse_remount(
				{
					revalidate: wake_val ?? live_opts.revalidate ?? 'load',
					...(live_opts.maxAge != null ? { maxAge: live_opts.maxAge } : {}),
					...(live_opts.onExpire != null ? { onExpire: live_opts.onExpire } : {})
				},
				err,
				names
			);
		} else if (render_mode === 'deferred') {
			attrs.set('defer', wake_val ?? 'load');
		} else if (wake_val != null) {
			attrs.set('hydrate', wake_val);
		}
		if (from_preset && !attrs.has('hydrate') && !attrs.has('defer')) {
			throw err(
				names,
				`${import_keys.preset} '${from_preset}' must set \`${import_keys.render}\` or \`${import_keys.wake}\` — a margin-only (or empty) preset is a no-op.`
			);
		}

		// Only UNKNOWN keys are errors. Presets are TOLERANT: a known-but-inapplicable key
		// (e.g. `margin` with a `load` island) is silently ignored — it applies wherever it's relevant.
		for (const k of attrs.keys()) {
			if (!ATTR_SCHEMA.has(k)) {
				throw err(names, from_preset ? `unknown key \`${k}\` in preset '${from_preset}'.` : `unknown import attribute \`${k}\`.`);
			}
		}
		if (remount_opt && attrs.get('hydrate') !== 'none') {
			throw err(names, `\`remount\` is only valid with \`${import_keys.wake}: 'none'\`.`);
		}

		// `defer` -> SERVER island (`render: deferred` or `live`). CONTENT-ONLY: a deferred region
		// never ships JS (Option A) — for interactivity nest a `wake` island inside its HTML. The value
		// is the FETCH schedule (from `wake`): 'load' (immediate, preload-hinted) | 'idle' | 'visible'
		// | a media query. `live` marks a hole that revalidates after its first fetch.
		if (attrs.has('defer')) {
			const dval = attrs.get('defer');
			let when;
			if (KNOWN_STRATEGIES.has(dval)) when = dval; // load | idle | visible
			else if (is_media_query(dval)) when = dval; // media query is the value itself
			else
				throw err(
					names,
					`\`${import_keys.render}: 'deferred'\` fetches on the \`${import_keys.wake}\` schedule, but '${dval}' is not one. Use \`${import_keys.wake}: 'load' | 'idle' | 'visible'\` or a media query (not 'none'/'interaction' — a hole must fetch).`
				);

			// `margin` applies when the fetch schedule is `visible` (tolerantly ignored otherwise).
			const options: { when: string; margin?: string; cacheTtlSec?: number } = { when };
			if (when === 'visible') options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
			// `maxAge` (preset) → response cache max-age in seconds, signed into the hole's endpoint. A
			// deferred hole is `no-store` (dynamic) unless it opts in here.
			if (live_opts.maxAge != null) {
				const ttl = parse_cache_ttl_sec(live_opts.maxAge, err, names);
				if (ttl != null && ttl > 0) options.cacheTtlSec = ttl;
			}

			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy: 'server', options });
			continue;
		}

		if (attrs.has('hydrate')) {
			const val = attrs.get('hydrate');
			if (val === 'none') {
				// hydrate: 'none' is a LAKE (render: page, hydrate: none). A lake INSIDE a hydrated
				// island freezes its subtree: SSR renders it inline, its JS ships in NO client chunk
				// (the island's client module swaps the import for a placeholder), and the runtime
				// lifts/restores its DOM around the parent hydrate. A lake in the dead shell is a
				// no-op plain component (dev-warned below). See DESIGN.md.
				// Always strip the `with{}` later (shell keeps cleaned import; unused/island lakes
				// drop the host binding). Never leave `with { hydrate: 'none' }` in emitted source.
				const lake_opts: {
					remount?: string;
					when?: string;
					margin?: string;
					maxAgeMs?: number;
					onExpire?: string;
				} = {};
				if (remount_opt) {
					lake_opts.remount = remount_opt.policy;
					if (remount_opt.when) lake_opts.when = remount_opt.when;
					if (remount_opt.maxAgeMs != null) lake_opts.maxAgeMs = remount_opt.maxAgeMs;
					if (remount_opt.onExpire) lake_opts.onExpire = remount_opt.onExpire;
					if (remount_opt.policy === 'swr' && remount_opt.when === 'visible') {
						lake_opts.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
					}
				}
				for (const spec of node.specifiers) {
					marked_components.set(spec.local.name, { strategy: 'lake', options: lake_opts });
				}
				continue;
			}
			if (val === 'false') {
				// Import-attribute values are strings; the "no hydration" value is the WORD 'none'
				// (not the boolean-looking 'false'). No silent alias — point the author at 'none'.
				throw err(
					names,
					`\`${import_keys.wake}: 'false'\` is not valid — use \`${import_keys.wake}: 'none'\` for a lake (a frozen region inside a hydrated island). See DESIGN.md.`
				);
			}
			let strategy;
			if (HYDRATE_STRATEGIES.has(val)) strategy = val;
			else if (is_media_query(val)) strategy = val; // media query is the value itself
			else
				throw err(
					names,
					`unknown ${import_keys.wake} strategy '${val}'. Use 'load' | 'idle' | 'visible' | 'interaction' | a media query.`
				);

			// `margin` applies only to `visible` (tolerantly ignored otherwise). Falls back to the
			// plugin-level default ogygia({ visible: { margin } }).
			const options: { margin?: string; keep?: string } = {};
			if (strategy === "visible") {
				options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
			}
			// CONTINUITY: `keep: 'name'` keeps the live island (DOM + mounted app + its $state)
			// across SPA navigations — the same node relocates onto the next page's slot instead of
			// remounting. A player keeps playing. Rides the data-ogygia-keep relocation.
			if (attrs.has('keep')) {
				const p = String(attrs.get('keep')).trim();
				if (!p) throw err(names, `\`keep\` needs a non-empty name (e.g. keep: 'player').`);
				options.keep = p;
			}

			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy, options });
			continue;
		}
		// otherwise: a normal import that happens to carry other import attributes — leave it.
	}

	// No islands here, but a `{#snippet}` may still need making portable (forwarded into an island by
	// the component it's handed to). Keep going for those; the island passes below no-op with an empty
	// `marked_components`, and the end guard returns `null` unchanged if no portable work happens.
	if (marked_components.size === 0 && !source.includes('{#snippet')) return null;

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
	const entry_source_for = (componentPath, iid) =>
		// The island entry loads on both client hydrate and server render. Importing the
		// transportables manifest here registers every `[ogygia.wire]` codec before props are
		// decoded, so an island receiving a transportable prop never needs to import the class
		// itself (an `import type` that the compiler erases would otherwise leave decode blind).
		`import 'virtual:ogygia/transportables';\n` +
		`import __OgygiaComp_${iid} from ${JSON.stringify(componentPath)};\n` +
		`export default __OgygiaComp_${iid};\n`;

	const hydrate_wrapper_source = (iid, componentPath, entryPath, strategy, options) => {
		const strategy_attrs = strategy_to_attr(strategy, options);
		const persist_attr = options?.keep ? ` __keep={${JSON.stringify(options.keep)}}` : '';
		const entry_url = ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid);
		return (
			`<script${lang}>\n` +
			`\timport { Region as OgygiaRegion__Wrapper } from 'ogygia/internal';\n` +
			`\timport __OgygiaEntry from ${JSON.stringify(entryPath)};\n` +
			`\timport __OgygiaCss from ${JSON.stringify(componentPath)};\n` +
			`\tlet { children, ...__props } = $props();\n` +
			`</script>\n` +
			`<OgygiaRegion__Wrapper __mode="island" ${strategy_attrs}${persist_attr} __entry={${JSON.stringify(entry_url)}} ` +
			`__component={__OgygiaEntry} __css={__OgygiaCss} {__props}>` +
			`{@render children?.()}</OgygiaRegion__Wrapper>\n`
		);
	};

	const server_wrapper_source = (iid, componentPath, entryPath, options) => {
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
			`\timport __OgygiaCss from ${JSON.stringify(componentPath)};\n` +
			`\tlet { ogygiaFallback, ...__props } = $props();\n` +
			`</script>\n` +
			`<OgygiaRegion__Wrapper __mode="server" __entry={${JSON.stringify(iid)}} __component={__OgygiaEntry} ` +
			`__css={__OgygiaCss} {__props} ${server_attrs} {ogygiaFallback} />\n`
		);
	};

	const lake_wrapper_source = (iid, componentPath, options) => {
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
			`\timport OgygiaLakeInner from ${JSON.stringify(componentPath)};\n` +
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
		const comp_rel = component_identity(componentPath);
		const identity = regionIdentity(comp_rel, mark);
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
					source: swr ? entry_source_for(componentPath, iid) : undefined,
					wrapperPath: wrapPath,
					wrapperSource: lake_wrapper_source(iid, componentPath, mark.options),
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
		const wants_attach = !is_server;
		const attach_binding = wants_attach
			? wrapper_attach_binding({
					iid,
					wrapperPath: wrapPath,
					componentPath,
					moduleUrl: ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid),
					hydrate: mark.strategy,
					hydrateMargin: mark.strategy === 'visible' ? (mark.options?.margin ?? undefined) : undefined
				})
			: null;
		if (!islands_by_id.has(iid)) {
			const entry_src = entry_source_for(componentPath, iid);
			const wrapper_src = is_server
				? server_wrapper_source(iid, componentPath, entryPath, mark.options)
				: hydrate_wrapper_source(iid, componentPath, entryPath, mark.strategy, mark.options);
			islands_by_id.set(iid, {
				id: iid,
				virtualPath: entryPath,
				wrapperPath: wrapPath,
				wrapperSource: wrapper_src,
				// Attach binding (wake islands only): the host imports THIS instead of the bare wrapper,
				// so the same binding both renders (`<C/>`) and holds (`region(C)`).
				...(attach_binding
					? {
							bindingPath: regionBindingVirtualId(iid),
							bindingSsrSource: attach_binding.ssr,
							bindingClientSource: attach_binding.client
						}
					: {}),
				source: entry_src,
				hostPath: id,
				componentPath,
				server: is_server,
				kind: is_server ? (deferred_hydrate ? 'hydrate' : 'defer') : 'hydrate',
				lakes: [],
				identity,
				// Capability marks for the per-app runtime: the actual wake schedule + defer timing +
				// persist name, so the generated entry bundles only the features this island needs.
				strategy: mark.strategy,
				fetchWhen: is_server ? mark.options?.when : undefined,
				wakeAfter: deferred_hydrate ? mark.options?.hydrate : undefined,
				keep: mark.options?.keep
			});
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
				attach_binding && link_virtual ? regionBindingVirtualId(iid) : bindingPath;
			s.overwrite(
				info.node.start,
				info.node.end,
				binding_rewrite(local, rewrite_path, componentPath)
			);
			rewritten_import_nodes.add(info.node);
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
	const portable_preloads: string[] = [];
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
		if (mutated.size > 0) continue; // writes host state — leave native (a snapshot can't write back)
		const cleaned_imports: string[] = [];
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
				cleaned_imports.push(text);
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
			// No-waterfall: the descriptor's entry url is known at SSR, so preload it in <head>. The
			// browser fetches the portable entry in parallel with the host island's chunk, not after it.
			if (ctx.ssr && !ctx.dev) portable_preloads.push(islandPublicUrl(iid));
		}
		s.remove(snip.start, snip.end);
		const insert_at = comp.start + 1 + String(comp.name).length;
		s.appendLeft(
			insert_at,
			` ${name}={${OG_PORTABLE}(${entry_ref}, ${cap_obj}, ${JSON.stringify(url)})}`
		);
		portable_emitted = true;
	}

	if (portable_preloads.length) {
		const links = [...new Set(portable_preloads)]
			.map((u) => `<link rel="modulepreload" href=${JSON.stringify(u)} />`)
			.join('');
		// A component may have ONE `<svelte:head>` — if the host already has one, MERGE the links
		// into it (appending a second head is a compile error the dev server never surfaces, since
		// this branch only runs for builds).
		const existing_head = /<svelte:head>/.exec(source);
		if (existing_head) {
			s.appendLeft(existing_head.index + '<svelte:head>'.length, links);
		} else {
			s.append(`\n<svelte:head>${links}</svelte:head>\n`);
		}
	}

	if (portable_emitted) {
		const head =
			`import { og_portable as ${OG_PORTABLE} } from 'ogygia';\n` + portable_imports.join('\n') + '\n';
		if (ast.instance) s.appendLeft(ast.instance.content.start, `\n${head}`);
		else s.prepend(`<script${lang}>\n${head}</script>\n`);
	}

	// Snippet-only files that produced no island or portable work are untouched — behave as bailed.
	if (!has_island_hint && !portable_emitted && islands_by_id.size === 0) return null;

	return {
		code: s.toString(),
		map: s.generateMap({ hires: true, source: id, includeContent: true }),
		islands: [...islands_by_id.values()]
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
export function transformTsRegions(source, id, ctx) {
	const import_keys = normalize_import_keys(ctx.importKeys);
	const regionKey = import_keys.region;
	const wakeKey = import_keys.wake;
	// cheap bail — needs an import-attributes clause and either held marker name present
	if ((!source.includes(regionKey) && !source.includes(wakeKey)) || !source.includes('with')) return null;

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

	const s = new MagicString(source);
	const islands_by_id = new Map();
	let matched = false;
	// Default import + import-attributes clause: `import X from '…' with { … }` (the only form).
	const re = /import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2\s+with\s*\{([^}]*)\}\s*;?/g;
	let m;
	while ((m = re.exec(source))) {
		const [full, local, , spec, attrsRaw] = m;
		const attrs = parse_import_attrs(attrsRaw);
		const has_region = attrs.has(regionKey);
		const has_wake = attrs.has(wakeKey);
		if (!has_region && !has_wake) continue;
		// This is a raw-source regex, so it also matches import EXAMPLES embedded in template-literal
		// strings (a docs `snippets.ts` full of `import … with { wake: … }` code samples). A real
		// top-level import is never inside a backtick string — skip a match with an odd number of
		// (unescaped) backticks before it. Guards both markers, since `wake` is ubiquitous in samples.
		const before = source.slice(0, m.index);
		let backticks = 0;
		for (let i = 0; i < before.length; i++) {
			if (before[i] === '`' && before[i - 1] !== '\\') backticks++;
		}
		if (backticks % 2 === 1) continue;
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
		// `region: 'raw'` bakes no schedule; a `wake:` mark bakes its (validated) schedule.
		const options: { hydrate?: string; hydrateMargin?: string } = {};
		if (has_region) {
			normalize_region_value(attrs.get(regionKey), rel_host, regionKey);
		} else {
			const hydrate = normalize_hydrate_value(attrs.get(wakeKey), rel_host, wakeKey);
			options.hydrate = hydrate;
			if (hydrate === 'visible' && ctx.visibleMargin != null) options.hydrateMargin = ctx.visibleMargin;
		}
		const identity = regionIdentity(component_identity(componentPath), { strategy: 'held', options });
		const iid = regionId(identity, salt);
		const entryPath = ctx.virtualPathFor(id, iid);
		if (!islands_by_id.has(iid)) {
			islands_by_id.set(
				iid,
				make_region_binding({
					iid,
					componentPath,
					entryPath,
					hostPath: id,
					moduleUrl: ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid),
					hydrate: options.hydrate,
					hydrateMargin: options.hydrateMargin,
					identity
				})
			);
		}
		s.overwrite(
			m.index,
			m.index + full.length,
			`import ${local} from ${JSON.stringify(regionBindingVirtualId(iid))};`
		);
		matched = true;
	}
	if (!matched) return null;
	return {
		code: s.toString(),
		map: s.generateMap({ hires: true, source: id, includeContent: true }),
		islands: [...islands_by_id.values()]
	};
}
