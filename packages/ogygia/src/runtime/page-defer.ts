/**
 * Client side of streaming `$page.data` promises into islands (see `../page-defer.ts` for the why).
 *
 * The page seed carries a DEFER MARKER (`[id]`) for each pending promise; the reviver turns it into a
 * real pending Promise, so an island's `{#await page.data.x}` renders its pending branch. As each
 * promise settles the server streams `<script>__ogygia_page_resolve(id, ok, encoded)</script>`, which
 * resolves the matching Promise — the `{#await}` flips to its resolved branch, live.
 *
 * Ordering is fully decoupled: an inline bootstrap (first body chunk) defines the resolve global and
 * QUEUES calls until the runtime installs the live parser; the reviver may create a deferred before or
 * after its resolve arrives. One registry per document via a Symbol.for handle (dev evaluates the
 * runtime twice — a module-local map would split; PAGE-STATE-SINGLETON).
 */
import { parse } from 'devalue';
import {
	PAGE_DEFER_KEY,
	PAGE_SETTLED_KEY,
	PAGE_DEFER_GLOBAL,
	PAGE_DEFER_REGISTRY_KEY
} from '../page-defer.js';

export { PAGE_DEFER_BOOTSTRAP } from '../page-defer.js';

type Deferred = {
	promise: Promise<unknown>;
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
};
interface Registry {
	/** Raw resolves the inline bootstrap queued before the runtime installed `live`. */
	q?: Array<[id: number, ok: boolean, encoded: string]>;
	/** Live resolver (parses the encoded value); set by {@link install_page_defer}. */
	live?: (id: number, ok: boolean, encoded: string) => void;
	/** Pending promises by id, created by the reviver. */
	deferreds?: Map<number, Deferred>;
	/** Resolutions that landed before their promise was created. */
	settled?: Map<number, { ok: boolean; value: unknown }>;
	/** Full reviver map (defer + settled + app transport decoders) used to parse a streamed resolve. */
	revivers?: Record<string, (payload: never) => unknown>;
}

function reg(): Registry {
	const g = globalThis as unknown as Record<symbol, Registry | undefined>;
	return (g[PAGE_DEFER_REGISTRY_KEY] ??= {});
}

function to_error(value: unknown): Error {
	const msg =
		value && typeof value === 'object' && 'message' in value
			? String((value as { message: unknown }).message)
			: 'ogygia: streamed promise rejected';
	return new Error(msg);
}

/** Reviver: a defer marker `[id]` becomes a real Promise, pending until its resolve script lands (or
 *  already-resolved if the resolve raced ahead of the seed). */
export function create_deferred(id: number): Promise<unknown> {
	const r = reg();
	const deferreds = (r.deferreds ??= new Map());
	const existing = deferreds.get(id);
	if (existing) return existing.promise;
	const early = r.settled?.get(id);
	if (early) {
		r.settled!.delete(id);
		if (early.ok) return Promise.resolve(early.value);
		const p = Promise.reject(to_error(early.value));
		p.catch(() => {}); // resolve raced ahead of the island — guard before `{#await}` attaches its :catch
		return p;
	}
	let resolve!: (v: unknown) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	promise.catch(() => {}); // no unhandled-rejection noise if a rejected leaf goes un-awaited
	deferreds.set(id, { promise, resolve, reject });
	return promise;
}

function settle(id: number, ok: boolean, value: unknown): void {
	const r = reg();
	const d = r.deferreds?.get(id);
	if (d) {
		r.deferreds!.delete(id);
		if (ok) d.resolve(value);
		else d.reject(to_error(value));
	} else {
		(r.settled ??= new Map()).set(id, { ok, value });
	}
}

/** Install the live resolver (which parses the encoded value) and drain anything the inline bootstrap
 *  queued before the runtime loaded. `extra_revivers` are the app's transport decoders (custom types in
 *  a streamed value). Idempotent — safe to call on every boot; the first call's revivers win. */
export function install_page_defer(
	extra_revivers?: Record<string, (payload: never) => unknown>
): void {
	const r = reg();
	if (r.live) return;
	// A resolved value may carry NESTED defer markers (a promise that resolved to a value holding more
	// promises — mirrors Kit's recursive deferral) and app-transport custom types, so parse with the
	// full reviver map.
	r.revivers = page_defer_revivers(extra_revivers);
	r.live = (id, ok, encoded) => {
		let value: unknown = null;
		try {
			value = parse(encoded, r.revivers);
		} catch {
			/* leave null — a mangled chunk resolves to null, never hangs the `{#await}` */
		}
		settle(id, ok, value);
	};
	const queued = r.q;
	r.q = [];
	if (queued) for (const [id, ok, encoded] of queued) r.live(id, ok, encoded);
	// If the inline bootstrap never ran (e.g. an SPA-navigated seed), define the global directly.
	const g = globalThis as unknown as Record<string, unknown>;
	g[PAGE_DEFER_GLOBAL] ??= (id: number, ok: boolean, encoded: string) => r.live!(id, ok, encoded);
}

/** devalue reviver map for the page seed. A DEFER marker becomes a pending Promise (streaming path); a
 *  SETTLED marker becomes an already resolved/rejected Promise (non-navigate path). Both keep
 *  `page.data.x` a Promise, so `{#await}` works identically regardless of how the page was requested.
 *  `extra` merges the app's transport decoders; ogygia's own keys always win on any name clash. */
export function page_defer_revivers(
	extra?: Record<string, (payload: never) => unknown>
): Record<string, (payload: never) => unknown> {
	return {
		...extra,
		[PAGE_DEFER_KEY]: (payload: never) => create_deferred((payload as [number])[0]),
		[PAGE_SETTLED_KEY]: (payload: never) => {
			const [ok, value] = payload as [boolean, unknown];
			if (ok) return Promise.resolve(value);
			const p = Promise.reject(to_error(value));
			p.catch(() => {}); // no unhandled-rejection noise if a rejected leaf goes un-awaited
			return p;
		}
	};
}
