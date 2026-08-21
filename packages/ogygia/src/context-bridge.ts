/**
 * Cross-island context — one bridge, plain `getContext`.
 *
 * Component trees break at every island boundary; the DOM tree does not. A `<Provide values={…}>`
 * writes its values into the DOM (serialized with the SAME codec as island props), and ogygia seeds
 * each island's `hydrate({ context })` from the providers above it — so a child island's own
 * `getContext('key')`, unchanged, reads a (csr=false) layout's context across the island-root split.
 * A `[ogygia.wire]` value resolves to the one live instance (shared + reactive); a plain value is a
 * per-consumer snapshot.
 *
 * `createContext(key)` is optional TYPED sugar over the same string key — callable to make a
 * `<Provide>` entry, `.get()` to read (typed). Nothing DOM-specific on the consumer side.
 */
import { getContext, setContext as svelte_set_context } from 'svelte';
import { parse, stringify } from 'devalue';
import { DEV } from 'esm-env';
import { REF_WIRE_KEY, ref_reducer, ref_reviver, batch } from './ref.js';
// PULL-registration: kinds register inside the seam functions below (idempotent, tree-shake-proof,
// and the modules stay free of import-time side effects).
import { register_wire_kind } from './live-transport.js';
import { register_store_kind, register_derived_kind } from './store-transport.js';
import { register_snippet_kind } from './region-snippet.js';
import { register_fn_kind, is_branded_fn } from './fn-transport.js';

function ensure_ctx_kinds(): void {
	register_wire_kind();
	register_store_kind();
	register_snippet_kind();
	register_fn_kind();
	register_derived_kind();
}
import { boundary_problems, format_boundary_finding } from './boundary.js';
import { PAGE_CTX_MARKER, record_ctx, type SetContextOptions } from './context-registry.js';
import { escape_script_text } from './escape.js';

/** The `<Provide>` seam carries classes, stores AND snippets (a snippet freezes/travels live). */
const PROVIDE_FAMILIES = new Set(['wire', 'store', 'snippet', 'fn', 'derived']);
/** The drop-in page-marker seam deliberately EXCLUDES snippets: there, a bare function must
 *  THROW (and be dropped with a dev explanation) rather than be silently frozen as one. */
const BRIDGE_FAMILIES = new Set(['wire', 'store', 'fn', 'derived']);

/** Serialize a context value for the DOM — same codec as island props (one hub key). */
export function serialize_context(value: unknown): string {
	ensure_ctx_kinds();
	return escape_script_text(stringify(value, { [REF_WIRE_KEY]: ref_reducer(PROVIDE_FAMILIES) }));
}

/**
 * Serialize for the drop-in `setContext` page marker WITHOUT the region-snippet reducer. That reducer
 * treats every function as a snippet (snippets are unbranded functions), which would silently turn a
 * `setContext('trackPageView', fn)` — or a class method — into a bogus snippet instead of failing.
 * Here a function must THROW so the offending value gets dropped (see below). Transportables
 * (`[ogygia.wire]`) and stores (auto-wired: value crosses, islands reunite to one live instance)
 * cross. A snippet in context is a `<Provide>` concern, not this drop-in path.
 */
function stringify_bridgeable(value: unknown): string {
	ensure_ctx_kinds();
	return escape_script_text(stringify(value, { [REF_WIRE_KEY]: ref_reducer(BRIDGE_FAMILIES) }));
}

/**
 * Serialize the drop-in `setContext` page-root bag for the DOM marker. A layout may `setContext` a
 * FUNCTION (e.g. `trackPageView`) or a DOM-holding object — values that genuinely can't cross an
 * island boundary. Rather than crash the page (or bridge a broken value), drop the offenders
 * key-by-key and bridge the rest; in DEV each drop is explained by the boundary classifier (key +
 * path + what to do), so a missing context inside an island is never a mystery. Returns null if
 * nothing serializable remains. The happy path (all serializable) is a single `stringify`.
 */
/** DEV threshold for the page-marker payload — islands ship context into every page's HTML. */
const CTX_SIZE_WARN_BYTES = 32 * 1024;

export function serialize_provided_context(map: Map<string, unknown>): string | null {
	const obj: Record<string, unknown> = {};
	for (const [k, v] of map) obj[k] = v;
	try {
		const payload = stringify_bridgeable(obj);
		if (DEV && payload.length > CTX_SIZE_WARN_BYTES) warn_ctx_size(map, payload.length);
		return payload;
	} catch {
		const safe: Record<string, unknown> = {};
		for (const k in obj) {
			try {
				stringify_bridgeable({ [k]: obj[k] });
				safe[k] = obj[k];
				if (DEV) warn_boundary(k, obj[k], false);
			} catch {
				// Can't bridge (function / DOM / unwired class) — native setContext still served the
				// same-root tree; islands won't see this key. In DEV, say exactly why.
				if (DEV) warn_boundary(k, obj[k], true);
			}
		}
		return Object.keys(safe).length ? stringify_bridgeable(safe) : null;
	}
}

/** DEV: the page marker is heavy — name the biggest keys so the fix is obvious (mark them
 *  { islands: false }, or slim the value). Sizes are per-key serialized lengths. */
function warn_ctx_size(map: Map<string, unknown>, total: number): void {
	const sizes: Array<[string, number]> = [];
	for (const [k, v] of map) {
		try {
			sizes.push([k, stringify_bridgeable({ [k]: v }).length]);
		} catch {
			/* unbridgeable keys are dropped elsewhere */
		}
	}
	sizes.sort((a, b) => b[1] - a[1]);
	const top = sizes
		.slice(0, 3)
		.map(([k, n]) => `'${k}' ~${(n / 1024).toFixed(1)}kB`)
		.join(', ');
	console.warn(
		`[ogygia] the island context marker is ${(total / 1024).toFixed(1)}kB — it ships in every page's HTML. ` +
			`Biggest keys: ${top}. Slim the values, or mark host-only keys with setContext(key, value, { islands: false }).`
	);
}

/** DEV: explain a dropped (or degraded-but-bridged) context key via the classifier. */
function warn_boundary(key: string, value: unknown, dropped: boolean): void {
	const problems = boundary_problems(value, key);
	if (dropped && problems.length === 0) {
		console.warn(`[ogygia] context '${key}' could not be serialized for islands and was dropped.`);
		return;
	}
	for (const f of problems) {
		if (dropped || f.kind === 'warn') console.warn(format_boundary_finding(key, f));
	}
}

/** Decode one serialized provider payload; a corrupt payload yields nothing (never breaks hydration). */
function parse_ctx(text: string | null | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	ensure_ctx_kinds();
	try {
		// decode is universal: whatever kind arrives, the hub resolves it (browser → remember).
		// BATCH (phase B): a page's context keys often reference each other's instances (a derived
		// over a store, a wire holding a store) — resolve them as ONE transaction so no watcher
		// reacts to a half-decoded graph.
		return batch(() =>
			parse(text, { [REF_WIRE_KEY]: ref_reviver(true) as (d: never) => unknown })
		) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Walk up from an island being hydrated, collecting every `<ogygia-provide>` above it (nearest wins)
 * into one Map, then fold in the single page-level `<script data-ogygia-provide-page>` marker as the
 * ROOT (lowest priority). ogygia seeds `hydrate(…, { context })` with the Map, so a child island's own
 * `getContext('key')` — unchanged — reads a layout's context across the island-root split on a
 * csr=false page.
 *
 * Two providers feed it: a `<Provide>` component (scoped, walked up — nesting/shadowing correct), and
 * the drop-in `setContext` (page marker — one flat root the whole page shares, for existing layouts
 * that just import `setContext` from `ogygia`). Scoped beats root on the same key. Undefined when
 * neither exists (the common case: nothing to seed, no cost). Same decode codec as island props (a
 * `[ogygia.wire]` value revives to its one live instance).
 */
export function collect_provided_context(start: Element | null): Map<string, unknown> | undefined {
	let el: Element | null = start;
	let map: Map<string, unknown> | undefined;
	const fold = (values: Record<string, unknown> | undefined) => {
		if (!values) return;
		map ??= new Map();
		// Nearest wins: the scoped walk sees the closest provider FIRST, and the page root LAST.
		for (const k in values) if (!map.has(k)) map.set(k, values[k]);
	};
	while (el) {
		if (el.tagName === 'OGYGIA-PROVIDE') {
			fold(parse_ctx(el.querySelector(':scope > script[data-ogygia-provide]')?.textContent));
		}
		el = el.parentElement;
	}
	// Page-level root from the drop-in `setContext` (emitted once by the handle before `</body>`).
	if (typeof document !== 'undefined') {
		fold(parse_ctx(document.querySelector(`script[${PAGE_CTX_MARKER}]`)?.textContent));
	}
	return map;
}

/** A typed context handle: callable to make a `<Provide>` entry, `.get()` to read (typed). */
export interface Context<T> {
	/** `theme('dark')` → `{ theme: 'dark' }` — an entry for `<Provide values={[ … ]}>`. */
	(value: T): Record<string, unknown>;
	/** Typed read — plain `getContext(key)` under the hood (seeded across islands), or the default. */
	get(): T | undefined;
	/** The underlying string key, for `getContext(theme.key)` interop. */
	readonly key: string;
}

/**
 * Typed sugar over a string context key, shared with plain `getContext`. Callable to produce a
 * `<Provide>` entry, `.get()` to read (typed). The key is the same string plain `getContext` uses, so
 * typed and untyped code read the same context. An optional default is returned when nothing is
 * provided above.
 *
 * ```ts
 * export const theme = createContext<'light' | 'dark'>('theme', 'light');
 * // provide: <Provide values={[ theme('dark') ]}>…</Provide>
 * // read:    theme.get()          // typed
 * //          getContext('theme')  // untyped — same key, same value
 * ```
 */
export function createContext<T>(key: string, defaultValue?: T): Context<T> {
	const ctx = ((value: T): Record<string, unknown> => ({ [key]: value })) as Context<T>;
	Object.defineProperty(ctx, 'key', { value: key, enumerable: true });
	ctx.get = (): T | undefined => {
		const v = getContext<T | undefined>(key);
		return v !== undefined ? v : defaultValue;
	};
	return ctx;
}

/**
 * Drop-in `setContext` — swap `import { setContext } from 'svelte'` for `from 'ogygia'` and an
 * existing csr=false layout's context reaches child islands with NO other change.
 *
 * It does exactly what Svelte's does (sets context for same-root descendants + the SSR-nested tree),
 * AND on the server records the value so the handle can emit one page-level marker every island seeds
 * from — closing the gap where a plain `setContext` shows up on the server but is gone on the client
 * (child islands are separate hydration roots). Only string keys bridge (they must serialize and be
 * read by `getContext('key')`); a symbol key is Svelte-only, same-root, no bridge.
 *
 * GRANULARITY: the optional third argument is the explicit marker — `{ islands: false }` keeps a key
 * host-native (same-root context works, nothing serializes). The default bridges: a missing key in an
 * island is a broken app, extra bytes are not. Ogygia never infers readership from `getContext` call
 * sites (aliased imports and wrapper modules would make any scan miss reads — the fatal direction).
 *
 * This is the FLAT page root: every island on the page inherits it. For scoped/shadowed context use
 * `<Provide>`, which wraps its subtree and beats the root on the same key.
 */
export function setContext<T>(key: unknown, value: T, opts?: SetContextOptions): T {
	// Only string keys can bridge (islands read `getContext('key')`), and a function value can never
	// serialize — record neither. Native setContext still runs, so same-root reads are unchanged; a
	// store or class instance is recorded but dropped later by `serialize_provided_context` if it can't
	// serialize, so it never crashes the page.
	// a BARE function can never serialize — but an og.$-branded one is a transportable fn ref
	if (typeof key === 'string' && (typeof value !== 'function' || is_branded_fn(value)))
		record_ctx(key, value, opts);
	return svelte_set_context(key, value);
}

/**
 * Kept for ABI: the build still emits a registration call for each `createContext(...)` export (that
 * used to tag keyless handles by `module#export`). Keys are explicit now, so this is a no-op.
 */
export function __tag_context(): void {}
