/**
 * The filename convention — how a folder of files encodes structure. Pure functions + one strategy
 * object ({@link numbered}), consumed by {@link folder}. Lives in CONTENT now (not ogygia): ordering
 * from `NN-` prefixes is generic corpus knowledge (a blog wants it too), and the outline reads the
 * RESULT — `order`/`groups` as data — so it never parses a filename.
 */

// ── regexes
const ORDER_PREFIX_RE = /^\d+-/;
const ORDER_PREFIX_DIGITS_RE = /^(\d+)-/;
const REGEX_SPECIAL_G = /[.*+?^${}()|[\]\\]/g;

/** Strip a leading `NN-` ordering prefix from one path segment. `00-start` → `start`. */
export function strip_order_prefix(segment: string): string {
	return segment.replace(ORDER_PREFIX_RE, '');
}

/** Read a leading `NN-` prefix as a number; missing prefix sorts last. `00-start` → 0. */
export function order_of(segment: string): number {
	const m = segment.match(ORDER_PREFIX_DIGITS_RE);
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
	/**
	 * How to treat two siblings that share a prefix number (`21-svelte-store`, `21-svelte-motion`).
	 * `'error'` (default) — a duplicate is usually an authoring mistake, so fail. `'allow'` — the
	 * prefix is a deliberate GROUP key (an imported corpus like the Svelte docs does this); ties then
	 * order alphabetically by segment. Set `'allow'` when sourcing folders you don't hand-number.
	 */
	duplicates?: 'error' | 'allow';
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
			const prefixed = segments.filter((s) => ORDER_PREFIX_RE.test(s));
			if (prefixed.length === 0) return []; // unordered directory — the convention isn't in use here
			const issues: string[] = [];
			const bare = segments.filter((s) => !ORDER_PREFIX_RE.test(s));
			if (bare.length) {
				issues.push(
					`ordering in ${at}: mixed prefixed and unprefixed siblings — prefix ${bare.slice(0, 4).join(', ')}${bare.length > 4 ? ', …' : ''} (or opt out with "ordered": false in +meta.json)`
				);
			}
			const digits = prefixed.map((s) => s.match(ORDER_PREFIX_DIGITS_RE)![1]);
			const widths = new Set(digits.map((d) => d.length));
			if (opts.pad !== undefined ? [...widths].some((w) => w !== opts.pad) : widths.size > 1) {
				const seen = [...new Set(prefixed.map((s) => s.match(ORDER_PREFIX_RE)![0]))]
					.slice(0, 6)
					.join(', ');
				issues.push(
					`ordering in ${at}: inconsistent prefix padding (${seen})${opts.pad !== undefined ? ` — expected ${opts.pad} digits` : ''}`
				);
			}
			const nums = digits.map(Number).sort((a, b) => a - b);
			const dupes = [...new Set(nums.filter((n, i) => i > 0 && nums[i - 1] === n))];
			if (dupes.length && opts.duplicates !== 'allow') {
				issues.push(
					`ordering in ${at}: duplicate prefix number${dupes.length > 1 ? 's' : ''} ${dupes.join(', ')} — siblings: ${[...prefixed].sort().join(', ')} (intentional? pass numbered({ duplicates: 'allow' }))`
				);
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

// ── the DATED convention — date-prefixed filenames (a blog's native ordering) ──

export type DatedOptions = {
	/** Date-prefix format: `YYYY`/`MM`/`DD` tokens plus literal separators — `'YYYY-MM-DD'` (default),
	 *  `'YYYYMMDD'`, `'DD-MM-YYYY'`, `'YYYY.MM.DD'`, …. The prefix is joined to the slug by `-`. */
	format?: string;
};

type CompiledFormat = { re: RegExp; date_re: RegExp; order: Array<'Y' | 'M' | 'D'> };

const compiled_formats = new Map<string, CompiledFormat>();

function compile_format(format: string): CompiledFormat {
	const hit = compiled_formats.get(format);
	if (hit) return hit;
	let re = '';
	const order: Array<'Y' | 'M' | 'D'> = [];
	for (let i = 0; i < format.length;) {
		if (format.startsWith('YYYY', i)) {
			re += String.raw`(\d{4})`;
			order.push('Y');
			i += 4;
		} else if (format.startsWith('MM', i)) {
			re += String.raw`(\d{2})`;
			order.push('M');
			i += 2;
		} else if (format.startsWith('DD', i)) {
			re += String.raw`(\d{2})`;
			order.push('D');
			i += 2;
		} else {
			re += format[i]!.replace(REGEX_SPECIAL_G, String.raw`\$&`);
			i += 1;
		}
	}
	if (!(order.includes('Y') && order.includes('M') && order.includes('D')) || order.length !== 3) {
		throw new Error(
			`[ogygia/content] dated(): format '${format}' must contain YYYY, MM and DD exactly once`
		);
	}
	const out: CompiledFormat = {
		re: new RegExp(`^${re}-(.+)$`),
		date_re: new RegExp(`^${re}-`),
		order
	};
	compiled_formats.set(format, out);
	return out;
}

function parts_of(
	segment: string,
	format: string
): { y: number; m: number; d: number; slug: string } | null {
	const { re, order } = compile_format(format);
	const match = re.exec(segment);
	if (!match) return null;
	const by = { Y: 0, M: 0, D: 0 };
	order.forEach((k, i) => (by[k] = Number(match[i + 1])));
	if (by.M < 1 || by.M > 12 || by.D < 1 || by.D > 31) return null;
	return { y: by.Y, m: by.M, d: by.D, slug: match[order.length + 1]! };
}

/** Read the date prefix off one segment as ISO `YYYY-MM-DD` (whatever the authored format), or null
 *  when the segment isn't date-prefixed / the date is impossible. Exported so an app can recover the
 *  date for DISPLAY from `filePath` — the convention strips it from the slug. */
export function date_of(segment: string, format = 'YYYY-MM-DD'): string | null {
	const p = parts_of(segment, format);
	if (!p) return null;
	const pad = (n: number, w: number) => String(n).padStart(w, '0');
	return `${pad(p.y, 4)}-${pad(p.m, 2)}-${pad(p.d, 2)}`;
}

/**
 * The dated convention: date-prefixed segments order siblings chronologically (order = days since
 * epoch, so `refs()` come back oldest→newest; a blog index reverses). The date is stripped from the
 * slug — URLs stay `/blog/release`, not `/blog/2026-08-13-release` — and recoverable for display
 * via {@link date_of} on the entry's `filePath`. Undated segments (directories, one-off pages) pass
 * through unordered. Verification is deliberately loose: only an UNPARSEABLE date-looking prefix is
 * an error — mixing dated posts with undated pages is normal for a blog.
 */
export function dated(opts: DatedOptions = {}): Convention {
	const format = opts.format ?? 'YYYY-MM-DD';
	compile_format(format); // validate the format eagerly — a bad one is a config error, not per-file
	return {
		segment(raw) {
			const p = parts_of(raw, format);
			if (!p) return { slug: raw, order: Number.MAX_SAFE_INTEGER };
			return { slug: p.slug, order: Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000) };
		},
		label: title_case,
		verify(dir, segments, meta) {
			if (meta?.ordered === false) return [];
			const at = dir || '(root)';
			const { date_re } = compile_format(format);
			const issues: string[] = [];
			for (const s of segments) {
				if (date_re.test(s) && !parts_of(s, format)) {
					issues.push(`dated ordering in ${at}: '${s}' has an impossible date prefix`);
				}
			}
			return issues;
		}
	};
}
