/**
 * Cross-island context — `createContext()`, DOM-bridged.
 *
 * Component trees break at every island boundary; the DOM tree does not. So context is scoped to
 * the DOM: a `<Context of={ctx} value={v}>` writes the value into the DOM at its spot (serialized
 * with the SAME codec as props), and `ctx.get()` in any island below walks up the DOM to the
 * nearest matching provider and decodes it. A `[ogygia.wire]` value resolves to the one live
 * instance (shared + reactive); a plain value comes back as a snapshot.
 *
 * On the SERVER, islands render nested in the page's SSR tree, so Svelte's own context works and
 * `get()` uses it. On the CLIENT, islands are separate roots, so `get()` walks the DOM instead.
 *
 * The identity that both the server and every island bundle must agree on is a build-assigned tag
 * (`module#export`, same alias-proof scheme as `wire`) — set via `__tag_context`.
 */
import { getContext as svelte_get_context } from 'svelte';
import { parse, stringify } from 'devalue';
import { TRANSPORT_WIRE_KEY, reduce_transportable, revive_transportable } from './live-transport.js';
import {
	REGION_SNIPPET_WIRE_KEY,
	reduce_region_snippet,
	revive_region_snippet
} from './region-snippet.js';

/** Build-assigned identity (`module#export`) carried on the context handle. */
const CTX_TAG = Symbol.for('ogygia.context.tag');
/** The region the runtime is currently hydrating — the DOM anchor `get()` walks up from. */
const CURRENT_REGION = Symbol.for('ogygia.context.current-region');

interface ContextHandle<T> {
	[CTX_TAG]: string;
	/** The value provided above the current island, or the default, or `undefined`. */
	get(): T | undefined;
}

const g = globalThis as Record<symbol, unknown>;

/** Runtime sets the region it is about to hydrate so `get()` knows where to start walking. */
export function set_current_region(el: Element | null) {
	g[CURRENT_REGION] = el;
}

/** The context tag for a handle (used by `<Context>` to know which key to write). */
export function context_tag(handle: unknown): string {
	return (handle as Record<symbol, unknown>)?.[CTX_TAG] as string;
}

/** Serialize a context value for the DOM — same codec as island props (transportables included). */
export function serialize_context(value: unknown): string {
	return stringify(value, {
		[TRANSPORT_WIRE_KEY]: reduce_transportable,
		[REGION_SNIPPET_WIRE_KEY]: reduce_region_snippet
	})
		.split('<')
		.join('\\u003C');
}

/** Walk up the DOM from `start` to the nearest `<ogygia-context ctx=tag>` and decode its value. */
function read_from_dom(start: Element | null, tag: string): unknown {
	let el: Element | null = start;
	while (el) {
		if (el.tagName === 'OGYGIA-CONTEXT' && el.getAttribute('ctx') === tag) {
			const script = el.querySelector(':scope > script[data-ogygia-ctx]');
			const text = script?.textContent;
			if (text) {
				try {
					return parse(text, {
						[TRANSPORT_WIRE_KEY]: (d: never) => revive_transportable(d, true),
						[REGION_SNIPPET_WIRE_KEY]: revive_region_snippet
					});
				} catch {
					return undefined;
				}
			}
		}
		el = el.parentElement;
	}
	return undefined;
}

/**
 * Define a typed cross-island context. No string key — the build tags it by `module#export`, so
 * the provider and every consumer island agree on identity without a magic string.
 *
 * ```ts
 * // context.ts
 * export const cart = createContext<Cart>();          // get(): Cart | undefined
 * export const theme = createContext('light');        // get(): string (has a default)
 * ```
 */
export function createContext<T>(defaultValue: T): ContextHandle<T> & { get(): T };
export function createContext<T>(): ContextHandle<T>;
export function createContext<T>(defaultValue?: T): ContextHandle<T> {
	const handle: ContextHandle<T> = {
		[CTX_TAG]: '',
		get(): T | undefined {
			const tag = handle[CTX_TAG];
			// Server: islands render nested in the page tree, so Svelte's own context reaches them.
			if (typeof window === 'undefined') {
				const v = svelte_get_context<T | undefined>(tag);
				return v !== undefined ? v : defaultValue;
			}
			// Client: separate roots — walk the DOM from the island being hydrated.
			const found = read_from_dom((g[CURRENT_REGION] as Element | null) ?? null, tag) as
				| T
				| undefined;
			return found !== undefined ? found : defaultValue;
		}
	};
	return handle;
}

/** Build-generated: bind a `createContext()` export to its stable `module#export` tag. */
export function __tag_context(tag: string, handle: unknown): void {
	if (handle && typeof handle === 'object' && CTX_TAG in handle) {
		(handle as Record<symbol, unknown>)[CTX_TAG] = tag;
	}
}
