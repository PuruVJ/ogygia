/**
 * DATA SOURCES — `import.meta.og.source(fn)`, the RUNTIME half (the compiler rewrites the macro to
 * `__og_source('<file#export>', fn, opts?)`, injecting the import from `ogygia/internal`).
 * Isomorphic + tiny: on the server, each call records a receipt tag (`s:<id>:<fingerprint(args)>`)
 * — kept with the request's facts while its render may be stored (the invalidation reverse
 * index), and shown to an observer (a federated fragment reporting what its render read);
 * everywhere else it is a pure pass-through. `sourceTag(fn, args)` (the plugin door) reads the
 * stamped id back off the function — one side, no strings, typos are type errors.
 *
 * The recorder and observer ride ONE `globalThis` slot: several module instances (dist entries,
 * a plugin package beside core) must share the seam.
 */
// The house hash — runtime/hash.ts owns FNV-1a (region fps, flag buckets); never re-rolled.
import { fnv1a } from './runtime/hash.ts';

interface SourceSlots {
	recorder: ((tag: string) => void) | null;
	observer: ((tag: string) => void) | null;
}
const slots: SourceSlots = ((globalThis as unknown as Record<symbol, SourceSlots>)[
	Symbol.for('ogygia.sources')
] ??= {
	recorder: null,
	observer: null
});

/** hooks.ts installs this once — files a receipt with the current request's facts. */
export function set_source_recorder(fn: ((tag: string) => void) | null): void {
	slots.recorder = fn;
}

/** federate() installs this once — every receipt tag. */
export function set_source_observer(fn: ((tag: string) => void) | null): void {
	slots.observer = fn;
}

/** Called by the `__og_source` wrapper on every invocation (and by a peer handle for the tags it
 *  ADOPTS from a remote fragment). Neither seam may fail the app's own call. */
export function record_source_read(tag: string): void {
	try {
		slots.recorder?.(tag);
	} catch {
		/* a receipt must never fail the app's own call */
	}
	try {
		slots.observer?.(tag);
	} catch {
		/* same law */
	}
}

/** The identity stamp — read by `freeze.invalidate(fn, args)`. */
export const SOURCE_ID: unique symbol = Symbol.for('ogygia.freeze.source-id');
/** The optional `{ key }` canonicalizer stamp (exotic signatures). */
export const SOURCE_KEY: unique symbol = Symbol.for('ogygia.freeze.source-key');

export interface SourceOptions<A extends unknown[]> {
	/** Canonicalize exotic args to a stable string yourself; default = structural fingerprint. */
	key?: (...args: A) => string;
}

/** Canonicalize one argument: event-ish shapes collapse to their route identity (a whole
 *  RequestEvent can never ride a fingerprint), URLs to pathnames, functions to a marker. */
function canonical(value: unknown, depth = 0): unknown {
	if (value === null || typeof value !== 'object') {
		return typeof value === 'function' ? '[fn]' : value;
	}
	if (depth > 4) return '[deep]';
	if (value instanceof URL) return value.pathname;
	const v = value as Record<string, unknown>;
	// event-shaped: { url, request?, cookies?, route? } → (route id, pathname)
	if (v.url instanceof URL && ('request' in v || 'cookies' in v)) {
		const route = (v.route as { id?: string | null } | undefined)?.id ?? null;
		return { __route: route, __path: v.url.pathname };
	}
	if (typeof Request !== 'undefined' && value instanceof Request) return '[request]';
	if (Array.isArray(value)) return value.map((x) => canonical(x, depth + 1));
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(v).sort()) out[key] = canonical(v[key], depth + 1);
	return out;
}

/** The structural fingerprint of a call's args — stable across processes and time. */
export function fingerprint_args(args: unknown[]): string {
	try {
		return fnv1a(JSON.stringify(canonical(args)));
	} catch {
		return 'opaque';
	}
}

/** `s:<id>:<fp>` — the receipt/eviction tag for one (source, args) pair. */
export function source_tag(id: string, fingerprint: string): string {
	return `s:${id}:${fingerprint}`;
}

/** The compiled form of `export const X = import.meta.og.source(fn, opts?)`. */
export function __og_source<A extends unknown[], R>(
	id: string,
	fn: (...args: A) => R,
	opts?: SourceOptions<A>
): (...args: A) => R {
	const wrapped = (...args: A): R => {
		record_source_read(source_tag(id, opts?.key ? opts.key(...args) : fingerprint_args(args)));
		return fn(...args);
	};
	Object.defineProperty(wrapped, SOURCE_ID, { value: id });
	if (opts?.key) Object.defineProperty(wrapped, SOURCE_KEY, { value: opts.key });
	return wrapped;
}

/** A function stamped by the macro. */
type SourceFn = ((...args: never[]) => unknown) & {
	[SOURCE_ID]?: string;
	[SOURCE_KEY]?: (...args: unknown[]) => string;
};

/** The receipt tag one `(source, args)` call files, or null when `fn` is not a declared source. */
export function source_tag_of(fn: SourceFn, args: unknown[] = []): string | null {
	const id = fn[SOURCE_ID];
	if (!id) return null;
	const key_fn = fn[SOURCE_KEY];
	return source_tag(id, key_fn ? key_fn(...args) : fingerprint_args(args));
}
