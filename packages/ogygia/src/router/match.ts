/**
 * Pattern compilation + matching for the ogygia router. Kit's route grammar, reused verbatim so
 * nothing new is learned:
 *   /docs/[slug]      — one required segment  → { slug: string }
 *   /docs/[...rest]   — rest, may be empty     → { rest: string }
 *   /[[lang]]/docs    — optional segment       → { lang?: string }
 * Matching is trailing-slash-insensitive by default (refinement 1): `/docs/foo` and `/docs/foo/`
 * hit the same route with identical params. This module is pure — no rendering, no request — so the
 * whole match/specificity story is unit-testable by calling `compile()` + `match_path()` directly.
 */

export interface ParamSpec {
	name: string;
	/** `[...rest]` — captures the remaining path (slashes included), may be '' */
	rest?: boolean;
	/** `[[opt]]` — the segment may be absent; param is `undefined` when so */
	optional?: boolean;
}

export interface CompiledPattern {
	/** the original table key, e.g. '/docs/[slug]' — also the route.id we expose */
	pattern: string;
	regex: RegExp;
	params: ParamSpec[];
	/** higher = more specific; used to order overlapping matches (static beats dynamic) */
	score: number;
}

const escape_re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REST = /^\[\.\.\.([a-zA-Z_$][\w$]*)\]$/;
const OPTIONAL = /^\[\[([a-zA-Z_$][\w$]*)\]\]$/;
/** strips valid `[param]` groups so any leftover bracket flags a malformed segment */
const STRIP_PARAMS = /\[[a-zA-Z_$][\w$]*\]/g;

/**
 * Compile a pattern into a regex + its param specs + a specificity score. Throws on an obviously
 * malformed pattern (a rest segment that isn't last) — a loud build-time-ish error beats a route
 * that silently never matches.
 */
const INNER_PARAM = /\[([a-zA-Z_$][\w$]*)\]/g;

export function compile(pattern: string): CompiledPattern {
	if (!pattern.startsWith('/')) {
		throw new Error(`[ogygia/router] route pattern must start with "/": ${JSON.stringify(pattern)}`);
	}
	const segs = pattern.split('/').filter((s) => s !== '');
	const params: ParamSpec[] = [];
	// per-segment specificity digit (packed base-5): static=4, mixed=3, param=2, optional=1, rest=0
	const digits: number[] = [];
	let rx = '';

	segs.forEach((seg, i) => {
		let m: RegExpMatchArray | null;
		if ((m = seg.match(REST))) {
			if (i !== segs.length - 1) {
				throw new Error(
					`[ogygia/router] a [...rest] segment must be last: ${JSON.stringify(pattern)}`
				);
			}
			params.push({ name: m[1], rest: true });
			rx += '(?:/(.*))?';
			digits.push(0);
		} else if ((m = seg.match(OPTIONAL))) {
			params.push({ name: m[1], optional: true });
			rx += '(?:/([^/]+))?';
			digits.push(1);
		} else {
			// A normal segment: static text, a bare [param], OR a MIX (Kit allows `[id].json`,
			// `page-[n]`, etc.). Parse the [param] groups out, escaping the static bits between them.
			let inner = '/';
			let has_static = false;
			let has_param = false;
			let last = 0;
			INNER_PARAM.lastIndex = 0;
			let g: RegExpExecArray | null;
			while ((g = INNER_PARAM.exec(seg))) {
				const pre = seg.slice(last, g.index);
				if (pre) {
					inner += escape_re(pre);
					has_static = true;
				}
				inner += '([^/]+)';
				params.push({ name: g[1] });
				has_param = true;
				last = INNER_PARAM.lastIndex;
			}
			const tail = seg.slice(last);
			if (tail) {
				inner += escape_re(tail);
				has_static = true;
			}
			// any bracket left after removing the valid [param] groups = a malformed segment
			const leftover = seg.replace(STRIP_PARAMS, '');
			if (leftover.includes('[') || leftover.includes(']') || (!has_static && !has_param)) {
				throw new Error(`[ogygia/router] malformed segment ${JSON.stringify(seg)} in ${pattern}`);
			}
			rx += inner;
			digits.push(!has_param ? 4 : has_static ? 3 : 2);
		}
	});

	if (rx === '') rx = '/?'; // root '/'
	const regex = new RegExp('^' + rx + '/?$');

	// score: pack per-segment digits big-endian (base-5), then favour more segments. Static-heavy,
	// longer patterns sort first — '/docs/new' > '/docs/[slug]' > '/[...all]', and '[id].json' > '[id]'.
	let score = 0;
	for (const d of digits) score = score * 5 + d;
	score = score * 64 + digits.length; // length as a low-order tiebreaker

	return { pattern, regex, params, score };
}

/** Compile a whole table's keys and sort most-specific-first, so the first match wins. */
export function compile_all(patterns: string[]): CompiledPattern[] {
	return patterns.map(compile).sort((a, b) => b.score - a.score);
}

export interface PathMatch {
	pattern: string;
	params: Record<string, string | undefined>;
}

/** Match one compiled pattern against a pathname. Returns params, or null if it doesn't match. */
export function match_one(c: CompiledPattern, pathname: string): PathMatch | null {
	const m = c.regex.exec(pathname);
	if (!m) return null;
	const params: Record<string, string | undefined> = {};
	c.params.forEach((spec, i) => {
		const raw = m[i + 1];
		if (spec.rest) {
			params[spec.name] = raw == null ? '' : safe_decode(raw);
		} else if (spec.optional) {
			params[spec.name] = raw == null ? undefined : safe_decode(raw);
		} else {
			params[spec.name] = safe_decode(raw);
		}
	});
	return { pattern: c.pattern, params };
}

/** First (most-specific) match in a pre-sorted list, or null. */
export function match_path(sorted: CompiledPattern[], pathname: string): PathMatch | null {
	for (const c of sorted) {
		const hit = match_one(c, pathname);
		if (hit) return hit;
	}
	return null;
}

function safe_decode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s; // malformed %xx — hand back the raw segment rather than throw mid-route
	}
}
