/**
 * `import.meta.og.source(fn)` — the RUNTIME half (the compiler rewrites the macro to
 * `__og_source('<file#export>', fn, opts?)`, injecting this import). Isomorphic + tiny:
 * on the server, each call during a may-be-stored render records a receipt tag
 * (`s:<id>:<fingerprint(args)>`) into the request bag; everywhere else it is a pure
 * pass-through. `artifacts.invalidate(fn, args)` reads the stamped id off the function —
 * one side, no strings, typos are type errors.
 */
import { record_source_read } from './capture.js';
// The house hash — runtime/fingerprint.ts owns FNV-1a (region fps, flag buckets); never re-rolled.
import { fnv1a } from '../runtime/fingerprint.js';

/** The identity stamp — read by `artifacts.invalidate(fn, args)`. */
export const SOURCE_ID = Symbol.for('ogygia.artifacts.source-id');
/** The optional `{ key }` canonicalizer stamp (exotic signatures). */
export const SOURCE_KEY = Symbol.for('ogygia.artifacts.source-key');

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
