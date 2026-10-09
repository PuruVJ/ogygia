/**
 * `span` + `tag` — the two things a profile cannot learn on its own, written into the app.
 *
 *   • `span(name, fn)` names a stretch of a request the sampler cannot see: a database driver on
 *     its own socket pool, a queue, a cache lookup, a promise chain. It is recorded like an
 *     outbound call — start and end on the profiler's clock, the request it ran in, the caller's
 *     file and line, its parent span — and the report treats it as one: a named block on the
 *     timeline (a gap inside it reads "in db.users" instead of "nothing recorded"), a row in the
 *     Spans table, a link in the awaits-in-a-row detector, a finding when it repeats or fails.
 *   • `tag(key, value)` stamps the current request's log entry, so slow routes can be split by
 *     tenant, locale, variant — whatever the app knows and the profiler does not.
 *
 * Universal and dependency-free: the profiler host installs the recorder for the duration of a
 * recording; everywhere else (the client, a universal load in the browser, a server with no
 * recording running) `span` runs the function and returns it, and `tag` does nothing. One `if`.
 *
 * ```ts
 * import { span, tag } from 'ogygia/profiler';
 *
 * export const load = async ({ params, locals }) => {
 *   tag('tenant', locals.tenant);
 *   const user = await span('db.user', () => db.users.find(params.id));
 *   const orders = await span('db.orders', () => db.orders.byUser(user.id), (r) => ({ rows: r.length }));
 *   return { user, orders };
 * };
 * ```
 */
import type { CallerSite } from './net.js';
import { register_profiler_file } from './frames.js';

// This file's frames are the profiler's, not the app's: the caller of a span is the frame ABOVE
// `span()`. Registered by identity because a workspace link bundles this file into the app's
// own chunk, where no '/profiler/' path substring survives.
register_profiler_file();

export type SpanAttrs = Record<string, string | number | boolean>;

export interface SpanRecord {
	id: number;
	name: string;
	/** performance.now() at start */
	start: number;
	/** duration; -1 while running (an `open` span at the end of a recording keeps -1) */
	ms: number;
	attrs?: SpanAttrs;
	/** the thrown error's message, when `fn` threw / the handle was `fail`ed */
	error?: string;
	/** never ended before the recording stopped */
	open?: boolean;
	/** the enclosing span's id, when nested */
	parent?: number;
	/** resolved at report time from `caller_site` (same as an outbound call's) */
	caller?: string;
	caller_site?: CallerSite;
	/** the page render that ran it, when known */
	route: string | null;
	path: string | null;
}

/** What the profiler host installs while a recording runs. */
export interface SpanRecorder {
	begin(name: string, attrs?: SpanAttrs): SpanRecord;
	/** run `fn` with `s` as the current span (nesting); the host binds it to its async context */
	within<T>(s: SpanRecord, fn: () => T): T;
	end(s: SpanRecord, attrs?: SpanAttrs, error?: unknown): void;
	tag(key: string, value: string): void;
}

let recorder: SpanRecorder | null = null;

/** The profiler host installs a recorder for a recording; `null` uninstalls. */
export function set_span_recorder(r: SpanRecorder | null): void {
	recorder = r;
}

/** Whether a recorder is installed (tests / the host). */
export function span_recording(): boolean {
	return recorder !== null;
}

/** A span opened by hand (`span.start`) for what a callback cannot wrap: a stream, an event. */
export interface SpanHandle {
	/** add or change an attribute while the span runs */
	set(key: string, value: string | number | boolean): void;
	/** close it; ending twice is a no-op */
	end(attrs?: SpanAttrs): void;
	/** close it as failed */
	fail(error: unknown): void;
}

const NOOP_HANDLE: SpanHandle = { set() {}, end() {}, fail() {} };

const is_thenable = (v: unknown): v is PromiseLike<unknown> =>
	!!v && typeof (v as { then?: unknown }).then === 'function';

/**
 * Run `fn` as a named span. Sync in, sync out; a promise in, a promise out — the wrapper never
 * changes the shape of what it wraps. A throw (or rejection) is recorded on the span and rethrown.
 * `attrs` is a plain record, or a function of the result for what is only known afterwards
 * (`(r) => ({ cache: r.fromCache ? 'hit' : 'miss', rows: r.length })`). Reserved keys the report
 * reads: `cache` ('hit' | 'miss'), `rows`, `bytes`, `key`; anything else is carried and shown.
 */
export function span<T>(
	name: string,
	fn: () => T,
	attrs?: SpanAttrs | ((result: Awaited<T>) => SpanAttrs | undefined)
): T {
	const r = recorder;
	if (r === null) return fn();
	const s = r.begin(name, typeof attrs === 'function' ? undefined : attrs);
	const finish = (result: unknown, error?: unknown) => {
		let extra: SpanAttrs | undefined;
		if (typeof attrs === 'function' && error === undefined) {
			try {
				extra = attrs(result as Awaited<T>);
			} catch {
				/* an attrs function must never fail the span */
			}
		}
		r.end(s, extra, error);
	};
	let out: T;
	try {
		out = r.within(s, fn);
	} catch (e) {
		finish(undefined, e ?? new Error('span failed'));
		throw e;
	}
	if (is_thenable(out)) {
		return (out as PromiseLike<unknown>).then(
			(v) => {
				finish(v);
				return v;
			},
			(e) => {
				finish(undefined, e ?? new Error('span failed'));
				throw e;
			}
		) as T;
	}
	finish(out);
	return out;
}

/** Open a span by hand; close it with `end` / `fail`. Nesting: spans started while another span's
 *  `fn` runs record it as their parent; a bare `span.start` at the top level has none. */
span.start = function start(name: string, attrs?: SpanAttrs): SpanHandle {
	const r = recorder;
	if (r === null) return NOOP_HANDLE;
	const s = r.begin(name, attrs);
	let done = false;
	return {
		set(key, value) {
			(s.attrs ??= {})[key] = value;
		},
		end(extra) {
			if (done) return;
			done = true;
			r.end(s, extra);
		},
		fail(error) {
			if (done) return;
			done = true;
			r.end(s, undefined, error ?? new Error('span failed'));
		}
	};
};

/** Stamp the current request with `key = value` (string, number or boolean; kept to 64 chars, at
 *  most 16 keys). Shown on the request's log row and in the report; the dashboard splits the
 *  slowest routes by any tag. A no-op outside a recording, and always on the client. */
export function tag(key: string, value: string | number | boolean): void {
	const r = recorder;
	if (r === null || !key) return;
	r.tag(String(key).slice(0, 64), String(value).slice(0, 64));
}

/**
 * INSTRUMENT a function once, so every call is a `span` — for a renderer or a client you call
 * from many places and cannot wrap at each site: a design system's `renderToString`, a database
 * client's `query`, an SDK method.
 *
 * Two forms:
 *   • `instrument(fn, name, attrs?)` returns a wrapped function (an ESM import is read-only, so
 *     bind the result: `const renderToString = instrument(renderToStringCore, 'ds.render')`).
 *   • `instrument(obj, 'method', name, attrs?)` patches the method in place (a client instance,
 *     a prototype) and returns a function that restores it.
 *
 * `attrs` gets the result AND the call's arguments, so a span can carry the tag it rendered or
 * the bytes it produced: `(html, tag) => ({ tag, bytes: html.length })`. Sync in, sync out; a
 * promise in, a promise out; `this` preserved. Outside a recording the wrapper is one `if`.
 *
 * ```ts
 * import { instrument } from 'ogygia/profiler';
 * import { renderToString as core } from '@acme/design-system/hydrate';
 * const renderToString = instrument(core, 'ds.render', (r, tag) => ({ tag, bytes: r.html.length }));
 * ```
 */
/** The attrs callback of `instrument`: the result, then the call's arguments. Declared method-style
 *  so a callback naming fewer arguments than the function takes (`(r, tag) => …` for a two-argument
 *  renderer) is accepted, and so it never narrows the wrapped signature. */
export type InstrumentAttrs<A extends unknown[], R> = {
	bivariant(result: Awaited<R>, ...args: NoInfer<A>): SpanAttrs | undefined;
}['bivariant'];
export function instrument<A extends unknown[], R>(
	fn: (...args: A) => R,
	name: string,
	attrs?: InstrumentAttrs<A, R>
): (...args: A) => R;
export function instrument<T extends object, K extends keyof T>(
	target: T,
	method: K,
	name: string,
	attrs?: T[K] extends (...args: infer A) => infer R ? InstrumentAttrs<A, R> : never
): () => void;
export function instrument(...args: unknown[]): unknown {
	if (typeof args[0] === 'function') {
		const [fn, name, attrs] = args as [(...a: unknown[]) => unknown, string, ((result: unknown, ...a: unknown[]) => SpanAttrs | undefined) | undefined];
		return wrap_call(fn, name, attrs);
	}
	const [target, method, name, attrs] = args as [Record<PropertyKey, unknown>, PropertyKey, string, ((result: unknown, ...a: unknown[]) => SpanAttrs | undefined) | undefined];
	const original = target[method];
	if (typeof original !== 'function') throw new Error(`instrument: ${String(method)} is not a function`);
	target[method] = wrap_call(original as (...a: unknown[]) => unknown, name, attrs);
	return () => {
		target[method] = original;
	};
}

function wrap_call(
	fn: (...a: unknown[]) => unknown,
	name: string,
	attrs: ((result: unknown, ...a: unknown[]) => SpanAttrs | undefined) | undefined
): (...a: unknown[]) => unknown {
	const wrapped = function (this: unknown, ...a: unknown[]) {
		if (recorder === null) return fn.apply(this, a);
		return span(name, () => fn.apply(this, a), attrs ? (result) => attrs(result, ...a) : undefined);
	};
	try {
		Object.defineProperty(wrapped, 'name', { value: fn.name || name });
		Object.defineProperty(wrapped, 'length', { value: fn.length });
	} catch {
		/* frozen — the wrapper still works */
	}
	return wrapped;
}
