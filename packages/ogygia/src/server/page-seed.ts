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

// Promises in `data` (Kit streaming) are handled by the handle via `page-stream.ts`: STREAMED into the
// island on a real navigation, or awaited + settled for a programmatic fetch. By the time a value
// reaches PageSeed it is either promise-free or carries DeferRef/SettledRef markers the caller's
// reducers encode — so this module just serializes, robustly.
export class PageSeed {
	/**
	 * Public page slice for islands. url/params/route/status are always plain and MUST survive;
	 * data/form/error may carry a non-serializable leaf (function/store/class) — that ONE field is
	 * dropped, never the whole seed. Promises should already be resolved by the handle
	 * (`resolve_promises`) before this. See INVARIANTS.md · PAGE-SEED.
	 */
	static serialize(page_ref: PageLike, stringify_fn: typeof stringify = stringify): string | null {
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
			let raw: string;
			try {
				raw = stringify_fn(full);
			} catch {
				// One non-serializable leaf must not nuke the whole seed: keep base + each of
				// data/form/error that serializes on its own.
				const safe: Record<string, unknown> = { ...base };
				for (const key of ['data', 'form', 'error'] as const) {
					try {
						stringify_fn(full[key]);
						safe[key] = full[key];
					} catch {
						/* drop just this field */
					}
				}
				raw = stringify_fn(safe);
			}
			return escape_script_text(raw);
		} catch {
			return null;
		}
	}
}
