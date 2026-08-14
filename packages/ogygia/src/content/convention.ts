/**
 * The filename convention — how a folder of files encodes structure. Pure functions + one strategy
 * object ({@link numbered}), consumed by {@link folder}. Lives in CONTENT now (not pharos): ordering
 * from `NN-` prefixes is generic corpus knowledge (a blog wants it too), and the outline reads the
 * RESULT — `order`/`groups` as data — so it never parses a filename.
 */

/** Strip a leading `NN-` ordering prefix from one path segment. `00-start` → `start`. */
export function strip_order_prefix(segment: string): string {
	return segment.replace(/^\d+-/, '');
}

/** Read a leading `NN-` prefix as a number; missing prefix sorts last. `00-start` → 0. */
export function order_of(segment: string): number {
	const m = segment.match(/^(\d+)-/);
	return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** `data-state` → `Data State`. The default label when no `+meta.json` overrides it. */
export function title_case(slug: string): string {
	return slug
		.split('-')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

/**
 * Directory decoration a `+meta.json` may carry. DELIBERATELY tiny — the blessed convention has one
 * ordering channel (the `NN-` prefix) and one naming channel (this file). Order does not belong
 * here (that would be a second way to say the same thing), and chrome behavior (collapsing,
 * badges) belongs to the spec/escape hatch, not to content decoration.
 */
export type MetaDecoration = {
	/** Display label for this directory's group (default: title-cased slug). */
	label?: string;
	/** Opt this directory out of (or force it into) the convention's ordering verification. */
	ordered?: boolean;
};

/** Read a loose json record into a typed decoration (defensive — the file is user-authored). */
export function read_meta(data: Record<string, unknown>): MetaDecoration {
	const out: MetaDecoration = {};
	if (typeof data.label === 'string') out.label = data.label;
	if (typeof data.ordered === 'boolean') out.ordered = data.ordered;
	return out;
}

// ── the convention as a STRATEGY — one blessed instance, one escape hatch ──

/**
 * The pluggable filename convention. `folder()` uses the blessed {@link numbered} instance unless you
 * hand it your own — pass a partial to keep the blessed behavior for the pieces you don't override.
 */
export interface Convention {
	/** One raw source segment → its structural meaning. Blessed: `02-data-state` → slug + order 2. */
	segment(raw: string): { slug: string; order: number };
	/** Default label for a clean slug (a `+meta.json` `label` still overrides). */
	label(slug: string): string;
	/**
	 * Verify one directory's SIBLING segments (raw, as authored). Runs once per directory during the
	 * folder scan; returned strings become named BUILD errors. `dir` is the clean path (`''` = root);
	 * `meta` is the directory's own `+meta.json`, so `{ "ordered": false }` can exempt a directory.
	 */
	verify(dir: string, segments: string[], meta: MetaDecoration | undefined): string[];
}

export type NumberedOptions = {
	/** Required digit count for prefixes (`2` → `01-`, rejects `1-`). Default: consistency only. */
	pad?: number;
	/** Require `01,02,03…` with no gaps. Default `false` (deleting a page shouldn't break the build). */
	contiguous?: boolean;
};

/**
 * The BLESSED convention: `NN-` prefixes order siblings, stripped from slugs, labels title-cased.
 * Its `verify` makes the convention self-checking wherever it is actually in use — a directory with
 * NO prefixed children is simply not ordered (fine); one prefixed child means ALL siblings commit.
 * A directory's `+meta.json` `{ "ordered": false }` exempts it entirely.
 */
export function numbered(opts: NumberedOptions = {}): Convention {
	return {
		segment(raw) {
			return { slug: strip_order_prefix(raw) || raw, order: order_of(raw) };
		},
		label: title_case,
		verify(dir, segments, meta) {
			if (meta?.ordered === false) return [];
			const at = dir || '(root)';
			const prefixed = segments.filter((s) => /^\d+-/.test(s));
			if (prefixed.length === 0) return []; // unordered directory — the convention isn't in use here
			const issues: string[] = [];
			const bare = segments.filter((s) => !/^\d+-/.test(s));
			if (bare.length) {
				issues.push(`ordering in ${at}: mixed prefixed and unprefixed siblings — prefix ${bare.slice(0, 4).join(', ')}${bare.length > 4 ? ', …' : ''} (or opt out with "ordered": false in +meta.json)`);
			}
			const digits = prefixed.map((s) => s.match(/^(\d+)-/)![1]);
			const widths = new Set(digits.map((d) => d.length));
			if (opts.pad !== undefined ? [...widths].some((w) => w !== opts.pad) : widths.size > 1) {
				const seen = [...new Set(prefixed.map((s) => s.match(/^\d+-/)![0]))].slice(0, 6).join(', ');
				issues.push(`ordering in ${at}: inconsistent prefix padding (${seen})${opts.pad !== undefined ? ` — expected ${opts.pad} digits` : ''}`);
			}
			const nums = digits.map(Number).sort((a, b) => a - b);
			const dupes = [...new Set(nums.filter((n, i) => i > 0 && nums[i - 1] === n))];
			if (dupes.length) {
				issues.push(`ordering in ${at}: duplicate prefix number${dupes.length > 1 ? 's' : ''} ${dupes.join(', ')} — siblings: ${[...prefixed].sort().join(', ')}`);
			}
			if (opts.contiguous && bare.length === 0 && dupes.length === 0) {
				const gaps = nums.some((n, i) => i > 0 && n !== nums[i - 1] + 1);
				if (gaps || (nums[0] !== 0 && nums[0] !== 1)) {
					issues.push(`ordering in ${at}: numbers are not contiguous (${nums.join(', ')})`);
				}
			}
			return issues;
		}
	};
}
