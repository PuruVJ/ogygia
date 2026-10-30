/** Serialize a Kit `page` snapshot for a single document-level ogygia side-channel. */
import { stringify } from 'devalue';
import { escape_script_text } from '../escape.js';

type PageLike = {
	url?: { href?: string };
	params?: Record<string, string>;
	route?: { id: string | null };
	status?: number;
	data?: unknown;
	form?: unknown;
	error?: unknown;
};

/** The seed's text and the lane it is in (`json` → the runtime reads it with `JSON.parse`). */
export interface SeedText {
	text: string;
	json: boolean;
}

// Promises in `data` (Kit streaming) are handled by the handle via `page-stream.ts`: STREAMED into the
// island on a real navigation, or awaited + settled for a programmatic fetch. By the time a value
// reaches PageSeed it is either promise-free or carries DeferRef/SettledRef markers the caller's
// reducers encode — so this module just serializes, robustly.
const DROPPED = Symbol('dropped');

/** `value` if it serializes; else, for a plain object when `by_key`, the object of its keys that
 *  do; else {@link DROPPED}. */
function serializable_part(value: unknown, stringify_fn: typeof stringify, by_key: boolean): unknown {
	try {
		stringify_fn(value);
		return value;
	} catch {
		if (!by_key || !value || typeof value !== 'object' || Array.isArray(value)) return DROPPED;
		const kept: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			try {
				stringify_fn(v);
				kept[k] = v;
			} catch {
				/* drop just this key */
			}
		}
		return kept;
	}
}

export class PageSeed {
	/**
	 * Public page slice for islands. url/params/route/status are always plain and MUST survive;
	 * data/form/error may carry a non-serializable leaf (function/store/class) — that ONE field is
	 * dropped, never the whole seed. Promises should already be resolved by the handle
	 * (`resolve_promises`) before this. See INVARIANTS.md · PAGE-SEED.
	 *
	 * `json`: the caller proved the whole slice JSON-exact (seed-refs.ts `analyze`) — then the seed
	 * goes out as native `JSON.stringify` output (an order of magnitude cheaper than devalue on a
	 * CMS tree), escaped once for the `<script>`. devalue output needs no escape (it writes `<`).
	 */
	static serialize(
		page_ref: PageLike,
		stringify_fn: typeof stringify = stringify,
		json = false
	): SeedText | null {
		try {
			const base = {
				url: page_ref.url?.href,
				params: page_ref.params,
				route: page_ref.route,
				status: page_ref.status
			};
			const full = {
				...base,
				data: page_ref.data,
				form: page_ref.form ?? null,
				error: page_ref.error ?? null
			};
			if (json) {
				try {
					return { text: escape_script_text(JSON.stringify(full)), json: true };
				} catch {
					/* the analysis was wrong about a leaf — devalue below is the safe lane */
				}
			}
			let raw: string;
			try {
				raw = stringify_fn(full);
			} catch {
				// One non-serializable leaf must not nuke the whole seed: keep base + each of
				// data/form/error that serializes on its own — and of `data`, each top-level key that
				// does (a load returning a value only the server renders, beside the keys islands read).
				const safe: Record<string, unknown> = { ...base };
				for (const key of ['data', 'form', 'error'] as const) {
					safe[key] = serializable_part(full[key], stringify_fn, key === 'data');
					if (safe[key] === DROPPED) delete safe[key];
				}
				raw = stringify_fn(safe);
			}
			return { text: raw, json: false };
		} catch {
			return null;
		}
	}
}
