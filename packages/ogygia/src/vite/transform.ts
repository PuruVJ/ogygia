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
 * Default import-attribute keys — the three-dial grammar. Internal role names stay `hydrate`/`defer`
 * (the wire format + runtime keep those anchors); the user-facing ATTRIBUTE names are the values.
 * Override via `ogygia({ importKeys })`.
 * - `hydrate` role → `wake` attribute (when JS runs)
 * - `defer` role → `fill` attribute (when HTML arrives)
 */
export const DEFAULT_IMPORT_KEYS = {
	wake: 'wake',
	fill: 'fill',
	preset: 'preset',
	region: 'region'
} as const;

/**
 * Import-attribute key names claimed by the transform
 * (`with { wake | fill | preset | region }`). Override via `ogygia({ importKeys })` when
 * another tool already uses the default names.
 */
export type ImportKeys = {
	/** When JS runs (default attribute `'wake'`). */
	wake: string;
	/** When HTML arrives — server island (default attribute `'fill'`). */
	fill: string;
	/** Named preset attribute (default `'preset'`). */
	preset: string;
	/** Held-across-a-boundary marker (default attribute `'region'`, only value `'raw'`) — a component
	 * a registry hands to `region()` where the transform can't see the call. */
	region: string;
};

const JS_IDENT = /^[A-Za-z_$][\w$]*$/;

// Invariant per-build — hoisted to module scope so they aren't reallocated on every transformHost.
const KNOWN_STRATEGIES = new Set(['load', 'idle', 'visible']);
// `interaction` is a wake-only schedule (first pointer/key/focus inside the region, with click
// replay) — not a fetch timing, so it is not a valid `fill` value.
const HYDRATE_STRATEGIES = new Set([...KNOWN_STRATEGIES, 'interaction']);
/** Inline attribute keys accepted after normalization (canonical internal names). */
const ATTR_SCHEMA = new Set(['hydrate', 'defer', 'margin', 'persist']);
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
	const fill = (overrides?.fill ?? DEFAULT_IMPORT_KEYS.fill).trim();
	const preset = (overrides?.preset ?? DEFAULT_IMPORT_KEYS.preset).trim();
	const region = (overrides?.region ?? DEFAULT_IMPORT_KEYS.region).trim();
	for (const [role, name] of [
		['wake', wake],
		['fill', fill],
		['preset', preset],
		['region', region]
	] as const) {
		if (!name || !JS_IDENT.test(name)) {
			throw new Error(
				`[ogygia] importKeys.${role} must be a non-empty JS identifier (got ${JSON.stringify(overrides?.[role])}).`
			);
		}
	}
	if (new Set([wake, fill, preset, region]).size !== 4) {
		throw new Error(
			'[ogygia] importKeys.wake, importKeys.fill, importKeys.preset, and importKeys.region must be distinct.'
		);
	}
	return { wake, fill, preset, region };
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
		`${esc(import_keys.wake)}|${esc(import_keys.fill)}|${esc(import_keys.preset)}|${esc(import_keys.region)}`
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
 * Deterministic client chunk path for a hydrate island (mirrors `ogygia-runtime.<hash>.js`).
 * SSR bakes this into `<ogygia-region entry>` so the sticky runtime can `import(entry)` with no
 * app-wide regions map — Kit builds server before client, so content-hashed Vite names can't hand off.
 */
export function islandChunkFileName(iid: string) {
	return `_app/immutable/ogygia-island.${iid}.js`;
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
 * dual-owns it with the emitFile island entry and Rolldown thin-facades `ogygia-island.*`.
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
	// Fetch timing is the consumer's own `{#if}` — a held region has no `fill` axis.
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
			`export default { ${meta}, __component: __ogRegionComp, __sign: __ogRegionSign, ` +
			`__renderHtml: (props) => __ogRegionRender(__ogRegionComp, { props }).body };\n`,
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
			`Object.assign(__OgygiaWrap, { ${meta}, __component: __ogRegionComp, __sign: __ogRegionSign, ` +
			`__renderHtml: (props) => __ogRegionRender(__ogRegionComp, { props }).body });\n` +
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
	const claimed = new Set([import_keys.wake, import_keys.fill, import_keys.preset]);
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
 * Everything a `remount: 'swr'` region needs must survive the wire: the endpoint re-renders the
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
			`\`remount: 'swr'\` region <${node.name}> cannot have children — the revalidate endpoint re-renders it from serialized props only, so snippets cannot cross. Move the content inside the component, or use remount 'cache' / 'empty'.`
		);
	}
	for (const attr of node.attributes ?? []) {
		if (attr.type === 'SpreadAttribute') continue;
		if (attr.type !== 'Attribute') {
			throw err(
				node.name,
				`\`remount: 'swr'\` region <${node.name}> cannot use \`${attr.type === 'BindDirective' ? 'bind:' + attr.name : attr.name || attr.type}\` — only plain attributes and spreads can be serialized for the revalidate endpoint.`
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
				`\`remount: 'swr'\` region <${node.name}> cannot use \`${name}\` — event/callback attributes cannot be serialized for the revalidate endpoint. Pass serializable data props instead.`
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
					`\`remount: 'swr'\` region <${node.name}> cannot use a function value for \`${name}\` — functions cannot be serialized for the revalidate endpoint.`
				);
			}
		}
	}
}

/** Resolve an import specifier to an absolute .svelte path (for SWR server entries). */
function resolve_component_path(spec, host_id, ctx) {
	if (typeof spec !== 'string') return null;
	if (spec === '$lib' || spec.startsWith('$lib/')) {
		return ctx.pathModule.join(ctx.libDir, spec === '$lib' ? '' : spec.slice('$lib/'.length));
	}
	if (spec.startsWith('.')) {
		return ctx.pathModule.resolve(ctx.pathModule.dirname(host_id), spec);
	}
	return null;
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
	// cheap bailout — the library only touches region imports (configured key names)
	if (!import_keys_hint(import_keys).test(source)) return null;

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
			import_keys.fill,
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
				`(or \`${import_keys.fill}\` / \`${import_keys.preset}\`) — the binding becomes a portable island component. ` +
				`For a click-loaded chunk that is not an island, use plain \`await import('./Comp.svelte')\` ` +
				`(no region attributes) inside a host island. ` +
				`To delay a real island until click, gate a static region import with \`{#if}\`.`
		);
	});
	reject_dynamic_region_imports(module_body, import_keys, (keys) => {
		throw new Error(
			`[ogygia] ${rel_host}: dynamic import() with { with: { ${keys.join(', ')} } } is not supported. ` +
				`Mark islands with a static \`import X from '…' with { ${import_keys.wake}: '…' }\` ` +
				`(or \`${import_keys.fill}\` / \`${import_keys.preset}\`) — the binding becomes a portable island component. ` +
				`For a click-loaded chunk that is not an island, use plain \`await import('./Comp.svelte')\` ` +
				`(no region attributes) inside a host island. ` +
				`To delay a real island until click, gate a static region import with \`{#if}\`.`
		);
	});

	// --- collect host imports & region marks (the two-key region model) --------
	// The authoring syntax is the import attribute, one concern per key:
	//   import Comp from './Comp.svelte' with { hydrate: 'visible', margin: '200px' };
	//   import Comp from './Comp.svelte' with { hydrate: '(min-width: 768px)' };
	//   import Comp from './Comp.svelte' with { defer: 'load' };   // deferred HTML hole
	// Values MUST be string literals (ES import-attribute spec). See DESIGN.md.
	/** localName -> { node, cleaned } */
	const imports = new Map();
	/** localName -> { strategy, options } */
	const marked_components = new Map();
	const imports_to_strip = new Set<{ start: number; end: number }>(); // ImportDeclaration nodes to remove from host

	// The region attribute names, once per host (invariant across the import loop below).
	const REGION_KEYS = [import_keys.wake, import_keys.fill, import_keys.preset, import_keys.region];

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

		// The import block carries hydrate and/or defer, or a preset (under configured names).
		// No option keys inline — all tuning lives in plugin config (ogygia({ presets })).
		/** @type {Map<string,string>} effective attributes (canonical hydrate/defer + margin) */
		let attrs;
		/** @type {{ strategy: string, when?: string } | undefined} */
		let remount_opt;
		let from_preset = null;
		if (inline.has(import_keys.preset)) {
			if (inline.size > 1) {
				throw err(
					names,
					`\`${import_keys.preset}\` must be the only import attribute — put its options (margin, remount, …) in the preset definition (ogygia({ presets })).`
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
			attrs = new Map();
			for (const [k, v] of Object.entries(preset)) {
				if (v == null) continue;
				if (k === 'remount') {
					remount_opt = parse_remount(v, err, names);
					continue;
				}
				// Presets speak the same attribute vocabulary as imports (`wake` / `fill` / `margin`);
				// normalize to the internal canonical keys the rest of the pipeline uses.
				const canon =
					k === import_keys.wake ? 'hydrate' : k === import_keys.fill ? 'defer' : k;
				attrs.set(canon, String(v));
			}
			if (!attrs.has('hydrate') && !attrs.has('defer')) {
				throw err(
					names,
					`${import_keys.preset} '${from_preset}' must set \`hydrate\` or \`defer\` — a margin-only (or empty) preset is a no-op.`
				);
			}
		} else {
			// inline may carry the configured hydrate and/or defer keys (combo = deferred client
			// island), and the continuity `persist` key (a session name for the live island).
			for (const k of inline.keys()) {
				if (k !== import_keys.wake && k !== import_keys.fill && k !== 'persist') {
					throw err(
						names,
						`\`${k}\` is not allowed inline. Use \`${import_keys.wake}\`, \`${import_keys.fill}\`, \`persist\`, or a named \`${import_keys.preset}\` — options like \`margin\` / \`remount\` belong in plugin config (ogygia({ presets })).`
					);
				}
			}
			// Normalize to canonical names for the rest of the pipeline.
			attrs = new Map();
			if (inline.has(import_keys.wake)) attrs.set('hydrate', inline.get(import_keys.wake));
			if (inline.has(import_keys.fill)) attrs.set('defer', inline.get(import_keys.fill));
			if (inline.has('persist')) attrs.set('persist', inline.get('persist'));
		}

		// Only UNKNOWN keys are errors. Presets are TOLERANT: a known-but-inapplicable key
		// (e.g. `margin` with `hydrate: 'load'`) is silently ignored — it applies wherever it's
		// relevant. `margin` / `remount` never reach here inline (rejected above).
		for (const k of attrs.keys()) {
			if (!ATTR_SCHEMA.has(k)) {
				throw err(names, from_preset ? `unknown key \`${k}\` in preset '${from_preset}'.` : `unknown import attribute \`${k}\`.`);
			}
		}
		if (remount_opt && attrs.get('hydrate') !== 'none') {
			throw err(names, `\`remount\` is only valid with \`${import_keys.wake}: 'none'\`.`);
		}

		// `hydrate: 'none'` + `defer` is nonsense (HTML later AND no JS) — warn and treat as defer-only.
		if (attrs.has('defer') && attrs.get('hydrate') === 'none') {
			if (ctx.dev) {
				console.warn(
					`[ogygia] ${rel_host}: \`${import_keys.wake}: 'none'\` together with \`${import_keys.fill}\` is nonsense — ` +
						`use \`${import_keys.fill}\` alone (HTML later, no JS). Ignoring hydrate; treating as a server island.`
				);
			}
			attrs.delete('hydrate');
		}

		// `defer` -> SERVER island (render: defer). Optional `hydrate` → deferred client island
		// (fetch HTML on defer schedule, then import(entry) + hydrate). Defer VALUE is the
		// fetch-timing: 'load' (immediate, preload-hinted) | 'idle' | 'visible' | a media query.
		// The old boolean spelling `defer: 'true'` is retired — point authors at `defer: 'load'`.
		if (attrs.has('defer')) {
			const dval = attrs.get('defer');
			if (dval === 'true') {
				throw err(
					names,
					`\`${import_keys.fill}: 'true'\` is no longer valid — a server island now takes a fetch-timing value. Use \`${import_keys.fill}: 'load'\` (immediate + preload) | 'idle' | 'visible' | a media query. See DESIGN.md.`
				);
			}
			let when;
			if (KNOWN_STRATEGIES.has(dval)) when = dval; // load | idle | visible
			else if (is_media_query(dval)) when = dval; // media query is the value itself
			else
				throw err(
					names,
					`unknown ${import_keys.fill} timing '${dval}'. Use 'load' | 'idle' | 'visible' | a media query.`
				);

			// `margin` applies to whichever axis is `visible` (tolerantly ignored otherwise).
			const options: {
				when: string;
				margin?: string;
				hydrate?: string;
				hydrateMargin?: string;
			} = { when };
			if (when === 'visible') options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;

			if (attrs.has('hydrate')) {
				const hval = attrs.get('hydrate');
				if (hval === 'false') {
					throw err(
						names,
						`\`${import_keys.wake}: 'false'\` is not valid — use \`${import_keys.wake}: 'none'\` for a lake (a frozen region inside a hydrated island). See DESIGN.md.`
					);
				}
				let hydrate_strategy;
				if (HYDRATE_STRATEGIES.has(hval)) hydrate_strategy = hval;
				else if (is_media_query(hval)) hydrate_strategy = hval;
				else
					throw err(
						names,
						`unknown ${import_keys.wake} strategy '${hval}'. Use 'load' | 'idle' | 'visible' | 'interaction' | a media query.`
					);
				options.hydrate = hydrate_strategy;
				if (hydrate_strategy === 'visible') {
					options.hydrateMargin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
				}
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
			const options: { margin?: string; persist?: string } = {};
			if (strategy === "visible") {
				options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
			}
			// CONTINUITY: `persist: 'name'` keeps the live island (DOM + mounted app + its $state)
			// across SPA navigations — the same node relocates onto the next page's slot instead of
			// remounting. A player keeps playing. Rides the existing data-ogygia-persist relocation.
			if (attrs.has('persist')) {
				const p = String(attrs.get('persist')).trim();
				if (!p) throw err(names, `\`persist\` needs a non-empty name (e.g. persist: 'player').`);
				options.persist = p;
			}

			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy, options });
			continue;
		}
		// otherwise: a normal import that happens to carry other import attributes — leave it.
	}

	if (marked_components.size === 0) return null;

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
					} else {
						// Hydrate island: host children/snippets CAN cross — the compiler ships them as a
						// synthesized entry that inlines the snippet and wraps the real component. Collect
						// the non-whitespace children for the main loop to build that entry.
						const kids = (node.fragment?.nodes ?? []).filter(
							(n) => !(n.type === 'Text' && !String(n.data ?? '').trim())
						);
						if (kids.length) {
							const list = hydrate_children_usages.get(name) ?? [];
							list.push({ node, kids });
							hydrate_children_usages.set(name, list);
						}
					}
				}
			}
			for (const k of CHILD_KEYS) if (node[k]?.nodes) visit_usages(node[k].nodes);
			if (node.type === 'Component' && node.fragment?.nodes) visit_usages(node.fragment.nodes);
		}
	};
	/** local name → hydrate-island usages that carry host children/snippets. */
	const hydrate_children_usages = new Map();
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
		const persist_attr = options?.persist ? ` __persist={${JSON.stringify(options.persist)}}` : '';
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
	 * that emitFile registers as `ogygia-island.*`.
	 */
	const binding_rewrite = (local, bindingPath, componentPathAbs) => {
		let text = `import ${local} from ${JSON.stringify(bindingPath)};`;
		if (
			!link_virtual &&
			typeof componentPathAbs === 'string' &&
			componentPathAbs &&
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

	/**
	 * Cross-island children: a hydrate island that receives host children/snippets ships them as a
	 * synthesized `.svelte` entry that inlines the snippet and wraps the real component, so the
	 * `csr=false` client hydrate has real code to render in that slot (the page's closure is gone).
	 *
	 * Free identifiers the snippet closes over are classified: a host IMPORT is re-imported into the
	 * synth (so `<BIsland/>` inside the children renders and hydrates with the parent, the nested-
	 * island degrade); a host VALUE is captured and serialized as a prop (`__ogFv`); a global is left
	 * as-is. Named + parameterized snippets need no special handling — they inline verbatim and Svelte
	 * compiles them. A snippet that ASSIGNS to a host value is rejected (a snapshot can't write back).
	 * Returns null when the island has no host children.
	 */
	const build_child_synth = (local, componentPath, usage) => {
		const { node, kids } = usage;
		const { free, mutated } = collectCaptureInfo(kids);
		if (mutated.size > 0) {
			throw err(
				local,
				`children of <${local}> assign to host value(s) (${[...mutated].join(', ')}) — a captured snapshot can't write back across the island boundary. Move that state inside the island.`
			);
		}
		const cleaned_imports: string[] = [];
		const captures: string[] = [];
		for (const name of free) {
			if (imports.has(name)) cleaned_imports.push(imports.get(name).cleaned.trim());
			else if (host_declared.has(name)) captures.push(name);
			// else: a global (Math, console, …) — referenced directly in the synth, needs no wiring.
		}
		const markup = source.slice(kids[0].start, kids[kids.length - 1].end);
		const hash = createHash('md5')
			.update(`${markup}\0${captures.join(',')}\0${cleaned_imports.join('\n')}`)
			.digest('hex')
			.slice(0, 12);
		const cap_line = captures.length ? `\tconst { ${captures.join(', ')} } = __ogFv;\n` : '';
		const synth =
			`<script${lang}>\n` +
			`\timport 'virtual:ogygia/transportables';\n` +
			`\timport OgygiaChildTarget from ${JSON.stringify(componentPath)};\n` +
			cleaned_imports.map((s) => `\t${s}\n`).join('') +
			`\tlet { __ogFv = {}, children: __ogSlot, ...__ogp } = $props();\n` +
			`\t__ogSlot; __ogFv;\n` +
			cap_line +
			`</script>\n` +
			`<OgygiaChildTarget {...__ogp}>${markup}</OgygiaChildTarget>\n`;
		return { hash, source: synth, captures, node, kids };
	};

	// ── Cross-island children, per call site ────────────────────────────────────────────────────
	// Each hydrate usage carrying host children becomes its OWN island, keyed by a hash of its
	// children: a synthesized `.svelte` entry inlines the snippet and wraps the real component. The
	// usage tag is rewritten to a synthetic per-usage binding (`Card__ogN`), so one component import
	// can be composed at any number of call sites with different children.
	let og_synth_counter = 0;
	const child_islands: Array<{
		local: string;
		mark: { strategy: string; options?: Record<string, unknown> | null };
		componentPath: string;
		cs: NonNullable<ReturnType<typeof build_child_synth>>;
		iid: string;
		entryPath: string;
		wrapPath: string;
		bindingPath: string;
		synthName: string;
		identity: string;
	}> = [];
	for (const [local, mark] of marked_components) {
		if (mark.strategy === 'lake' || mark.strategy === 'server' || mark.strategy === 'held') continue;
		const usages = hydrate_children_usages.get(local);
		if (!usages || usages.length === 0) continue;
		const info = imports.get(local);
		if (!info) continue;
		const componentPath = resolve_component_path(info.node.source?.value, id, ctx);
		if (!componentPath) {
			throw new Error(
				`[ogygia] ${rel_host}: region import '${local}' needs a resolvable module path ($lib/… or relative).`
			);
		}
		const comp_rel_c = posix_rel(componentPath);
		for (const usage of usages) {
			const cs = build_child_synth(local, componentPath, usage);
			const identity = regionIdentity(`${comp_rel_c}\0kids:${cs.hash}`, mark);
			const iid = regionId(identity, salt);
			const entryPath = ctx.virtualPathFor(id, iid).replace(JS_EXT, '.svelte');
			const wrapPath = wrapperPathFor(id, iid);
			const bindingPath = link_virtual ? wrapPath : binding_stub;
			const synthName = `${local}__og${og_synth_counter++}`;
			child_islands.push({ local, mark, componentPath, cs, iid, entryPath, wrapPath, bindingPath, synthName, identity });
		}
	}

	// The crossed range is the WHOLE children-usage tag (`<C>…</C>`), so the parent import isn't
	// counted as "used outside" by its own children usage, and a nested import inside is.
	const crossed_ranges: Array<[number, number]> = child_islands.map((ci) => [
		ci.cs.node.start,
		ci.cs.node.end
	]);
	const in_crossed = (pos) =>
		typeof pos === 'number' && crossed_ranges.some(([a, b]) => pos >= a && pos < b);
	// True if `local` is referenced OUTSIDE any crossed-children fragment (script or template). Errs
	// toward `true` (keep the island) — a false positive only leaves an unused chunk, never breaks.
	const referenced_outside_children = (local) => {
		for (const n of instance_body) if (n.type !== 'ImportDeclaration' && ast_refs_local(n, local)) return true;
		for (const n of module_body) if (n.type !== 'ImportDeclaration' && ast_refs_local(n, local)) return true;
		let found = false;
		const walk = (node) => {
			if (found || !node || typeof node !== 'object') return;
			if (Array.isArray(node)) return node.forEach(walk);
			if (in_crossed(node.start)) return; // skip the stripped subtree
			if ((node.type === 'Component' || node.type === 'Identifier') && node.name === local) {
				found = true;
				return;
			}
			for (const k in node) {
				if (k === 'type' || k === 'start' || k === 'end') continue;
				const v = node[k];
				if (v && typeof v === 'object') walk(v);
			}
		};
		walk(ast.fragment?.nodes ?? []);
		return found;
	};

	// Register per-usage islands, emit a synthetic binding import for each, and rewrite each usage
	// tag: rename its open/close tags to the synthetic name, strip the children, inject captures.
	const children_only = new Set<string>();
	const synth_imports_by_local = new Map<string, string[]>();
	for (const ci of child_islands) {
		if (!islands_by_id.has(ci.iid)) {
			islands_by_id.set(ci.iid, {
				id: ci.iid,
				virtualPath: ci.entryPath,
				wrapperPath: ci.wrapPath,
				wrapperSource: hydrate_wrapper_source(ci.iid, ci.componentPath, ci.entryPath, ci.mark.strategy, ci.mark.options),
				source: ci.cs.source,
				hostPath: id,
				componentPath: ci.componentPath,
				server: false,
				kind: 'hydrate',
				lakes: [],
				identity: ci.identity,
				strategy: ci.mark.strategy,
				persist: ci.mark.options?.persist
			});
		}
		const list = synth_imports_by_local.get(ci.local) ?? [];
		list.push(binding_rewrite(ci.synthName, ci.bindingPath, ci.componentPath));
		synth_imports_by_local.set(ci.local, list);

		const node = ci.cs.node;
		const open = ci.synthName + (ci.cs.captures.length ? ` __ogFv={{ ${ci.cs.captures.join(', ')} }}` : '');
		s.overwrite(node.start + 1, node.start + 1 + node.name.length, open);
		const frag = node.fragment?.nodes ?? [];
		if (frag.length) s.remove(frag[0].start, frag[frag.length - 1].end);
		const closeIdx = source.lastIndexOf('</' + node.name, node.end);
		if (closeIdx >= 0) s.overwrite(closeIdx + 2, closeIdx + 2 + node.name.length, ci.synthName);
	}
	for (const [local, imps] of synth_imports_by_local) {
		const info = imports.get(local)!;
		if (referenced_outside_children(local)) {
			// Also used as a plain island → keep the original import (the main loop rewrites it) and
			// append the synthetic bindings after it.
			s.appendLeft(info.node.end, '\n' + imps.join('\n'));
		} else {
			// Only ever composed with children → replace the original import with the synthetic ones.
			s.overwrite(info.node.start, info.node.end, imps.join('\n'));
			rewritten_import_nodes.add(info.node);
			children_only.add(local);
		}
	}

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

		// Every usage of this import carries children → already emitted as per-call-site islands above.
		if (children_only.has(local)) continue;

		// Consumed only inside a sibling island's crossed children (the synth re-imports it) → it needs
		// no island of its own here; strip the host import (it degrades + hydrates inside the parent).
		if (!hydrate_children_usages.has(local) && !referenced_outside_children(local)) {
			if (!rewritten_import_nodes.has(info.node)) imports_to_strip.add(info.node);
			continue;
		}

		const entry_spec = info.node.source?.value;
		const componentPath = resolve_component_path(entry_spec, id, ctx);
		if (!componentPath) {
			throw new Error(
				`[ogygia] ${rel_host}: region import '${local}' needs a resolvable module path ($lib/… or relative).`
			);
		}
		const comp_rel = posix_rel(componentPath);
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
		// (`fill`) and lake islands are placement-only. The attach binding is the leg-split module the
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
				fill: is_server ? mark.options?.when : undefined,
				wakeAfter: deferred_hydrate ? mark.options?.hydrate : undefined,
				persist: mark.options?.persist
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

	return {
		code: s.toString(),
		map: s.generateMap({ hires: true, source: id, includeContent: true }),
		islands: [...islands_by_id.values()]
	};
}

/** Parse a flat import-attributes clause body (`a: 'x', b: "y"`) into a key→value map. */
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

	const resolve_spec = (spec) => {
		if (typeof spec !== 'string') return null;
		if (spec === '$lib' || spec.startsWith('$lib/')) {
			return path.join(ctx.libDir, spec === '$lib' ? '' : spec.slice('$lib/'.length));
		}
		if (spec.startsWith('.')) return path.resolve(path.dirname(id), spec);
		return null;
	};

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
				`[ogygia] ${rel_host}: held-region import '${local}' needs a resolvable module path ($lib/… or relative).`
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
		const identity = regionIdentity(posix_rel(componentPath), { strategy: 'held', options });
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
