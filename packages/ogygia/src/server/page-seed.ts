/** Serialize a Kit `page` snapshot for a single document-level ogygia side-channel. */
import { stringify } from 'devalue';

type PageLike = {
	url?: { href?: string };
	params?: Record<string, string>;
	route?: { id: string | null };
	status?: number;
	data?: unknown;
	form?: unknown;
	error?: unknown;
};

export class PageSeed {
	/**
	 * Public page slice for islands. `data`/`form`/`error` are included when devalue-serializable —
	 * treat load data as client-visible (same contract as csr=true Kit pages). See INVARIANTS.md · PAGE-SEED.
	 */
	static serialize(page_ref: PageLike, stringify_fn: typeof stringify = stringify): string | null {
		try {
			const base = {
				url: page_ref.url?.href,
				params: page_ref.params,
				route: page_ref.route,
				status: page_ref.status
			};
			let raw: string;
			try {
				raw = stringify_fn({
					...base,
					data: page_ref.data,
					form: page_ref.form ?? null,
					error: page_ref.error ?? null
				});
			} catch {
				raw = stringify_fn(base);
			}
			return raw.replaceAll('<', '\\u003C');
		} catch {
			return null;
		}
	}
}
