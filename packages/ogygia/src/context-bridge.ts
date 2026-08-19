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
import { TRANSPORT_WIRE_KEY, reduce_transportable, revive_transportable } from './live-transport.js';
import {
	REGION_SNIPPET_WIRE_KEY,
	reduce_region_snippet,
	revive_region_snippet
} from './region-snippet.js';
import { PAGE_CTX_MARKER, record_ctx } from './context-registry.js';

/** Serialize a context value for the DOM — same codec as island props (transportables included). */
export function serialize_context(value: unknown): string {
	return stringify(value, {
		[TRANSPORT_WIRE_KEY]: reduce_transportable,
		[REGION_SNIPPET_WIRE_KEY]: reduce_region_snippet
	})
		.split('<')
		.join('\\u003C');
}

/** Decode one serialized provider payload; a corrupt payload yields nothing (never breaks hydration). */
function parse_ctx(text: string | null | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		return parse(text, {
			[TRANSPORT_WIRE_KEY]: (d: never) => revive_transportable(d, true),
			[REGION_SNIPPET_WIRE_KEY]: revive_region_snippet
		}) as Record<string, unknown>;
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
 * This is the FLAT page root: every island on the page inherits it. For scoped/shadowed context use
 * `<Provide>`, which wraps its subtree and beats the root on the same key.
 */
export function setContext<T>(key: unknown, value: T): T {
	if (typeof key === 'string') record_ctx(key, value);
	return svelte_set_context(key, value);
}

/**
 * Kept for ABI: the build still emits a registration call for each `createContext(...)` export (that
 * used to tag keyless handles by `module#export`). Keys are explicit now, so this is a no-op.
 */
export function __tag_context(): void {}
