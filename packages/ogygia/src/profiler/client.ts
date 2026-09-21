/**
 * `mark` — the browser twin of `span`: name a stretch of the visitor's time the server profile
 * cannot see (a design system's CDN components hydrating, a widget booting, a font arriving) and
 * the report shows it next to the islands' own hydration times, for the page.
 *
 *   • `mark(name, fn)` times a function or the promise it returns; `mark(name, promise)` times a
 *     promise you already hold. A throw or rejection is recorded (`error: true`) and rethrown.
 *   • `mark.event(name, type, target?)` times until an event fires — a web-components runtime's
 *     "all hydrated" event, a widget's `ready` — from the call (or from navigation start with
 *     `{ from: 'navigation' }`).
 *   • `mark.start(name)` opens one by hand; `end(attrs?)` closes it. `{ from: 'navigation' }` on
 *     either measures from the page's start instead of the call.
 *
 * Cost: nothing without the profiler's beacon tag in the document (the profiler puts it there
 * for its own logged-in user only) — one `querySelector` on the first call, then a boolean. With
 * it, one entry in a batch sent when the page is idle or hides. Never a request per mark.
 *
 * ```ts
 * import { mark } from 'ogygia/profiler/client';
 * mark.event('ds.hydrate', 'components-ready');         // the design system's runtime: every component hydrated
 * await mark('widget.boot', () => widget.init(), { version: '3' });
 * ```
 */
import { beacon_mark } from '../runtime/beacon.js';

export type MarkAttrs = Record<string, string | number | boolean>;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const is_thenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as { then?: unknown }).then === 'function';

export interface MarkHandle {
	/** close it; ending twice is a no-op */
	end(attrs?: MarkAttrs): void;
}

function mark_impl<T>(name: string, work: (() => T) | PromiseLike<T>, attrs?: MarkAttrs): T {
	const t0 = now();
	const done = (error?: boolean) => beacon_mark(name, now() - t0, error ? { ...attrs, error: true } : attrs, t0);
	let out: T;
	try {
		out = typeof work === 'function' ? (work as () => T)() : (work as T);
	} catch (e) {
		done(true);
		throw e;
	}
	if (is_thenable(out)) {
		return (out as PromiseLike<unknown>).then(
			(v) => {
				done();
				return v;
			},
			(e) => {
				done(true);
				throw e;
			}
		) as T;
	}
	done();
	return out;
}

function mark_event(name: string, type: string, target: EventTarget | null = typeof document !== 'undefined' ? document : null, opts: { from?: 'call' | 'navigation'; attrs?: MarkAttrs } = {}): Promise<void> {
	if (!target) return Promise.resolve();
	const t0 = opts.from === 'navigation' ? 0 : now();
	return new Promise<void>((resolve) => {
		target.addEventListener(
			type,
			() => {
				beacon_mark(name, now() - t0, opts.attrs, t0);
				resolve();
			},
			{ once: true }
		);
	});
}

function mark_start(name: string, attrs?: MarkAttrs, opts: { from?: 'call' | 'navigation' } = {}): MarkHandle {
	// `from: 'navigation'`: measure from the page's start, for something that finished before the
	// code marking it could run (a runtime that hydrated before an island woke)
	const t0 = opts.from === 'navigation' ? 0 : now();
	let ended = false;
	return {
		end(extra) {
			if (ended) return;
			ended = true;
			beacon_mark(name, now() - t0, extra ? { ...attrs, ...extra } : attrs, t0);
		}
	};
}

export const mark: (<T>(name: string, work: (() => T) | PromiseLike<T>, attrs?: MarkAttrs) => T) & {
	event: typeof mark_event;
	start: typeof mark_start;
} = Object.assign(mark_impl, { event: mark_event, start: mark_start });
