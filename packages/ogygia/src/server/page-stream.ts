/**
 * Server side of streaming `$page.data` promises into islands (see `../page-defer.ts` for the why).
 *
 * `stage_deferred` walks the captured page `data`/`form`, swaps every promise for a serializable
 * DEFER MARKER, and hands back the promise-free clone plus the promises to await. The clone goes into
 * the page seed (each marker becomes a real pending Promise on the client); as each promise settles we
 * stream a `<script>__ogygia_page_resolve(id, ok, encoded)</script>` chunk that resolves it live.
 */
import { stringify } from 'devalue';
import { PAGE_DEFER_KEY, PAGE_SETTLED_KEY } from '../page-defer.js';

const MAX_DEPTH = 10;

/** A THENABLE, not just a native Promise — Kit wraps streamed load promises, so `instanceof Promise`
 *  would miss them. Anything with a callable `.then` we can await. */
export const is_thenable = (v: unknown): v is PromiseLike<unknown> =>
	!!v &&
	(typeof v === 'object' || typeof v === 'function') &&
	typeof (v as { then?: unknown }).then === 'function';

/** Serializable stand-in for a pending promise leaf (streaming path). Encodes to its id. */
export class DeferRef {
	constructor(public readonly id: number) {}
}

/** Serializable stand-in for an already-settled promise leaf (non-navigate path). Encodes to
 *  `[ok, value]`; the client revives it as a resolved/rejected Promise. */
export class SettledRef {
	constructor(
		public readonly ok: boolean,
		public readonly value: unknown
	) {}
}

// devalue reducers for the page seed. A DeferRef serializes to `[id]` and a SettledRef to `[ok, value]`
// (arrays — NEVER a bare id, which for id 0 is falsy and devalue would read as "not handled", silently
// dropping the marker). `value` is walked recursively by devalue so nested Date/Map survive.
export const defer_reducer: Record<string, (v: unknown) => unknown> = {
	[PAGE_DEFER_KEY]: (v: unknown) => (v instanceof DeferRef ? [v.id] : undefined)
};
export const page_seed_reducers: Record<string, (v: unknown) => unknown> = {
	[PAGE_DEFER_KEY]: (v: unknown) => (v instanceof DeferRef ? [v.id] : undefined),
	[PAGE_SETTLED_KEY]: (v: unknown) => (v instanceof SettledRef ? [v.ok, v.value] : undefined)
};

export type Deferred = { id: number; promise: PromiseLike<unknown> };

/**
 * Replace every promise in `value` with a {@link DeferRef}, returning the promise-free clone plus the
 * deferred promises (id + promise to await). Plain objects/arrays are cloned; class instances and
 * primitives pass through untouched. Ids continue from `start_id` so `data` and `form` share one id
 * space across the whole seed. Bounded depth guards a pathological structure.
 */
export function stage_deferred(
	value: unknown,
	start_id = 0
): { staged: unknown; deferred: Deferred[]; next_id: number } {
	const deferred: Deferred[] = [];
	let id = start_id;
	const walk = (v: unknown, depth: number): unknown => {
		if (depth > MAX_DEPTH) return v;
		if (is_thenable(v)) {
			const ref = new DeferRef(id++);
			deferred.push({ id: ref.id, promise: v });
			return ref;
		}
		if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
		if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
			const out: Record<string, unknown> = {};
			for (const k in v as Record<string, unknown>) out[k] = walk((v as Record<string, unknown>)[k], depth + 1);
			return out;
		}
		return v;
	};
	return { staged: walk(value, 0), deferred, next_id: id };
}

/**
 * Non-navigate (SPA/router) fallback: deep-await every promise in `value`, wrapping each ORIGINAL
 * promise position in a {@link SettledRef} (resolved OR rejected — a rejection is caught, never
 * thrown, so the render can't crash). Nested promises inside a resolved value are settled too. The
 * client revives each SettledRef as a resolved/rejected Promise, so `page.data.x` stays a Promise on
 * this path exactly as on the streaming path, and `{#await …:catch}` works.
 */
export async function settle_deferred(value: unknown, depth = 0): Promise<unknown> {
	if (depth > MAX_DEPTH) return value;
	if (is_thenable(value)) {
		try {
			const resolved = await value;
			return new SettledRef(true, await settle_deferred(resolved, depth + 1));
		} catch (err) {
			return new SettledRef(false, normalize_error(err));
		}
	}
	if (Array.isArray(value)) return Promise.all(value.map((x) => settle_deferred(x, depth + 1)));
	if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		const out: Record<string, unknown> = {};
		await Promise.all(
			Object.keys(value).map(async (k) => {
				out[k] = await settle_deferred((value as Record<string, unknown>)[k], depth + 1);
			})
		);
		return out;
	}
	return value;
}

/** Does `value` hold any promise? (cheap probe — the common no-promise seed skips staging entirely.) */
export function has_deferred(value: unknown, depth = 0): boolean {
	if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return false;
	if (is_thenable(value)) return true;
	if (Array.isArray(value)) return value.some((x) => has_deferred(x, depth + 1));
	if (Object.getPrototypeOf(value) === Object.prototype) {
		for (const k in value as Record<string, unknown>)
			if (has_deferred((value as Record<string, unknown>)[k], depth + 1)) return true;
	}
	return false;
}

/**
 * The streamed resolve `<script>` body for one settled promise. The value is encoded WITH
 * {@link defer_reducer} so a re-staged value carrying nested DeferRef markers (a promise that resolved
 * to a value containing further promises) serializes — the client revives those as fresh pending
 * promises that later resolve scripts settle, exactly like Kit's recursive deferral. `ok=false` carries
 * a normalized `{ message }` (matches the page seed's error shape) so a rejected non-serializable value
 * can't blow up the stream. `<` is escaped so the payload can't break out of the `<script>`.
 */
export function resolve_script(
	global_name: string,
	id: number,
	settled: { ok: boolean; value: unknown },
	reducers: Record<string, (v: unknown) => unknown> = defer_reducer
): string {
	let ok = settled.ok;
	let encoded: string;
	try {
		encoded = stringify(ok ? settled.value : normalize_error(settled.value), reducers);
	} catch {
		// Non-serializable resolution — surface a typed error rather than hang the island's `{#await}`.
		encoded = stringify({ message: 'ogygia: streamed value is not serializable' });
		ok = false;
	}
	const json = JSON.stringify(encoded).replaceAll('<', '\\u003C');
	return `<script>${global_name}(${id},${ok},${json})</script>`;
}

export function normalize_error(err: unknown): { message: string } {
	if (err instanceof Error) return { message: err.message };
	if (err && typeof err === 'object' && 'message' in err) return { message: String((err as { message: unknown }).message) };
	return { message: String(err) };
}
