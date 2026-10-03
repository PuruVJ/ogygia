/**
 * PATTERNS — the known ways server code gets slow, recognised on the exact lines that cost the
 * most, and backed by what was measured there.
 *
 * The line ledger (ledger.ts) says WHICH lines cost what. This says WHY, in words a person can act
 * on: "a new number formatter is built on every call", "the whole string is copied once per item".
 * A pattern is only reported where the profile paid for it: every site is a ledger line with its
 * own CPU time or allocations, the code on that line has the shape, and the context agrees (the
 * line sits inside a loop, or its function ran many times). The same pattern in several places
 * reads as ONE item with every site listed, and an estimate of the time fixing it gives back.
 *
 * The code is read with a small tokenizer (strings and comments dropped, identifiers and
 * punctuation kept), never a regular expression, and only for the few dozen ledger lines.
 */
import type { FrameStat } from './analyze.js';
import type { LedgerLine } from './ledger.js';
import type { RetainedSite } from './insights.js';
import type { AwaitEdge, AwaitNode } from './timeline.js';
import {
	backtracks,
	calls_name,
	REGEXP_FRAME,
	regex_literals,
	function_body,
	import_aliases,
	needs_previous,
	promise_all_rewrite,
	tokens,
	wrapper_aliases,
	type SourceReader
} from './source-scan.js';

export type PatternKind =
	| 'formatter-per-call'
	| 'rescan-in-loop'
	| 'lookup-in-loop'
	| 'table-per-call'
	| 'regexp-per-call'
	| 'slow-regex'
	| 'deep-copy'
	| 'spread-accumulate'
	| 'string-build'
	| 'sort-per-call'
	| 'date-parse'
	| 'sync-io'
	| 'yield-per-item'
	| 'scan-for-key'
	| 'library-per-item'
	| 'waits-in-a-row'
	| 'repeat-request'
	| 'same-answer'
	| 'almost-same-answer'
	| 'kept-per-render'
	| 'seed-whole-read'
	| 'cache-never-hits'
	| 'same-every-request'
	| 'render-per-item'
	| 'late-island-wait'
	| 'batch-straggler'
	| 'same-document'
	| 'almost-same-document';

/** a two-or-three-word tag for each kind, for a badge beside a line */
export const PATTERN_LABEL: Record<PatternKind, string> = {
	'formatter-per-call': 'formatter per call',
	'rescan-in-loop': 'rescan per item',
	'lookup-in-loop': 'search per item',
	'table-per-call': 'rebuilt each call',
	'regexp-per-call': 'regex per call',
	'slow-regex': 'slow regex',
	'deep-copy': 'deep copy',
	'spread-accumulate': 'copy per step',
	'string-build': 'string growth',
	'sort-per-call': 'sort per call',
	'date-parse': 'date parsing',
	'sync-io': 'blocking disk',
	'yield-per-item': 'yields per item',
	'scan-for-key': 'walks to find a key',
	'waits-in-a-row': 'waits in a row',
	'repeat-request': 'same request again',
	'same-answer': 'same answer every render',
	'almost-same-answer': 'same answer but for a stamp',
	'kept-per-render': 'kept after render',
	'seed-whole-read': 'ships all page data',
	'cache-never-hits': 'cache never hits',
	'library-per-item': 'library call per item',
	'same-every-request': 'same work every request',
	'render-per-item': 'renders per item',
	'late-island-wait': 'waits for a late island',
	'batch-straggler': 'one slow call in a batch',
	'same-document': 'same page every request',
	'almost-same-document': 'same page but for a few parts'
};

export interface PatternSite {
	path: string;
	file: string;
	line: number;
	/** a line of a built chunk: the source module it came from (see LedgerLine.module) */
	module?: string;
	code: string;
	/** the function row this line belongs to (functions table key), when known */
	fn?: string;
	fn_name?: string;
	/** same every request: every function the line calls — all of it leaves the request with the
	 *  line (`injectBadges(sitemapHtml(PRODUCTS))` takes both) */
	moves?: string[];
	cpu_ms: number;
	alloc_bytes: number;
	gc_ms: number;
	/** how many times the function ran, when V8 counted it */
	calls?: number;
	/** the site sits inside a loop (a `for`, a `.map(`, an `{#each}`) */
	in_loop: boolean;
	/** CPU inside the libraries this line called (ledger `lib_ms`) */
	lib_ms?: number;
	/** those library functions, `name (pkg)` */
	libs?: string[];
	/** the site is inside a thin wrapper: the lines in ITS callers that call it (the place a cache
	 *  or a batch goes), each with whether that call runs in a loop */
	via?: CallSite[];
	/** a memory site: bytes it left alive after one more warm render */
	kept_bytes?: number;
	/** a memory site: some of it was kept INSIDE this package, which the line calls */
	mem_via?: string;
	/** a cache site: how many of the function's calls the cache answered */
	hits?: number;
	/** a same-answer site: the size of the answer that came back unchanged every render */
	answer_bytes?: number;
	/** a same-answer site whose requests carried who is asking (cookie / authorization): cache per user */
	personal?: boolean;
	/** a same-answer site: what the service's own Cache-Control allows (seconds to keep a copy; not to
	 *  store it at all; one user's) */
	upstream_cache?: CacheRules;
	/** the change, written out: these exact lines, and what to put in their place (a waits-in-a-row
	 *  chain of plain one-line awaits, proven independent, as one Promise.all) */
	rewrite?: { file: string; line: number; before: string; after: string };
	/** a memory site the growth check measured: still growing every render, or flat after one */
	grows?: boolean;
	/** a waiting site: the ms its calls waited in a row */
	wait_ms?: number;
	/** a waiting site: what it waited on (`GET api.shop.test/stock/:id`, `file read`) */
	target?: string;
	/** the code around the site (two lines each side), so the loop or the value it uses shows */
	context?: { start: number; lines: string[] };
}

/** lines each side of a site shown with it */
const CONTEXT = 2;
/** a context line longer than this is cut: it is there to be recognised, not read in full */
const CONTEXT_COLS = 160;

/** `{ context }` for a site, or nothing when the source is not available */
function ctx_field(
	source: SourceReader | undefined,
	path: string,
	line: number
): { context?: { start: number; lines: string[] } } {
	const got = source?.(path, Math.max(1, line - CONTEXT), line + CONTEXT);
	if (!got?.lines.length) return {};
	return {
		context: {
			start: got.start,
			lines: got.lines.map((l) =>
				l.length > CONTEXT_COLS ? l.slice(0, CONTEXT_COLS - 1) + '…' : l
			)
		}
	};
}

export interface CallSite {
	path: string;
	file: string;
	line: number;
	/** a line of a built chunk: the source module it came from (see LedgerLine.module) */
	module?: string;
	code: string;
	/** the calling function (functions table key) */
	fn?: string;
	in_loop: boolean;
}

export interface Pattern {
	kind: PatternKind;
	/** what is happening, in plain words */
	title: string;
	/** what to do about it */
	fix: string;
	/** a tiny before → after, when one says it better than words */
	example?: { before: string; after: string };
	sites: PatternSite[];
	/** the measured cost on the sites: CPU plus the GC their allocations caused */
	cost_ms: number;
	/** bytes the sites allocated */
	alloc_bytes: number;
	/** a rough estimate of the ms a fix gives back (a share of cost_ms that depends on the kind) */
	save_ms: number;
	/** the numbers behind it, one line */
	evidence: string;
	/** the cost is WAITING (calls in a row), not CPU: `cost_ms` / `save_ms` are wall-clock waits */
	wait?: boolean;
	/** the cost is MEMORY kept alive after a render: `kept_bytes` is it, and there is no time saving */
	kept_bytes?: number;
	/** a memory pattern: requests left before the heap is full at this rate (from the heap's room now) */
	requests_left?: number;
	/** a memory pattern the growth check measured: it kept climbing, or it levelled off */
	growth?: 'grows' | 'levels-off';
	/** a size pattern (ogygia's page seed): the bytes it makes ship with every page view */
	seed_bytes?: number;
	/** waits in a row: each site's chain, its calls in order on the recording's clock */
	chains?: { start: number; ms: number }[][];
	/** waits in a row: the saving the simple sum promised (every wait but the longest), kept when the
	 *  critical-path check cut `save_ms` below it */
	naive_save_ms?: number;
}

/**
 * THE CRITICAL PATH, not the sum: a chain of waits started together ends when its longest call
 * does, but the render goes on only once whatever ran BESIDE the chain is done too (Kit waits for
 * a layout load running alongside a page load; a Promise.all waits for all). So the time that
 * really comes off is the chain's end minus the later of its new end and the end (up to the old
 * chain end) of any call that overlapped it. Only calls that overlapped count: a call that started
 * after the chain ended comes later and moves up with it, it is not beside it. Each chain call is
 * found in the render's await graph by its start and length; undefined when the graph does not
 * hold the chains (another window, a capped graph).
 */
export function wait_save_on_path(
	p: Pick<Pattern, 'chains'>,
	awaits: { nodes: AwaitNode[]; edges: AwaitEdge[] } | undefined,
	_window_ms: number,
	w0: number
): { save_ms: number; bound_by?: string } | undefined {
	if (!awaits?.nodes.length || !p.chains?.length) return undefined;
	let save = 0;
	let bound_by: string | undefined;
	for (const chain of p.chains) {
		if (chain.length < 2) continue;
		const mine = new Set<AwaitNode>();
		for (const c of chain) {
			const t0 = c.start - w0;
			const node = awaits.nodes.find(
				(n) => !mine.has(n) && Math.abs(n.t0 - t0) <= 0.6 && Math.abs(n.t1 - n.t0 - c.ms) <= 1
			);
			if (!node) return undefined;
			mine.add(node);
		}
		const nodes = [...mine];
		const start = Math.min(...nodes.map((n) => n.t0));
		const end = Math.max(...nodes.map((n) => n.t1));
		const collapsed = start + Math.max(...nodes.map((n) => n.t1 - n.t0));
		// the calls that ran beside the chain: started before it ended, still running after it began
		let beside = collapsed;
		let who: string | undefined;
		for (const n of awaits.nodes) {
			if (mine.has(n) || n.t0 >= end || n.t1 <= start) continue;
			const until = Math.min(n.t1, end);
			if (until > beside) ((beside = until), (who = n.label));
		}
		save += Math.max(0, end - beside);
		if (who && !bound_by) bound_by = who;
	}
	return { save_ms: Math.round(save * 100) / 100, ...(bound_by ? { bound_by } : {}) };
}

/**
 * THE SAME ANSWER EVERY TIME: the GET calls that ran in EVERY profiled render and got the same bytes
 * back each time (the body fingerprint net.ts takes). Across requests the render asks for data that
 * did not change: an answer to cache (a CMS entry, a config, a price list, flags). Keyed like a
 * wait's `exact` (`GET <url>`). Needs two renders or more; a call whose body was not read (no
 * fingerprint) or that failed never counts.
 */
export function stable_answers(
	calls: readonly {
		method: string;
		url: string;
		status: number;
		start: number;
		body_hash?: string;
	}[],
	runs: readonly { start: number; end: number }[]
): Set<string> {
	const out = new Set<string>();
	if (runs.length < 2) return out;
	const by = new Map<string, { runs: Set<number>; hashes: Set<string> }>();
	for (const c of calls) {
		if (c.method !== 'GET' || c.status < 200 || c.status >= 300 || !c.body_hash) continue;
		const run = runs.findIndex((r) => c.start >= r.start && c.start <= r.end);
		if (run === -1) continue;
		const k = `GET ${c.url}`;
		const g = by.get(k) ?? by.set(k, { runs: new Set(), hashes: new Set() }).get(k)!;
		g.runs.add(run);
		g.hashes.add(c.body_hash);
	}
	for (const [k, g] of by) if (g.runs.size === runs.length && g.hashes.size === 1) out.add(k);
	return out;
}

/** the GETs made in EVERY render whose answers were NOT the same bytes each time (`GET <url>`):
 *  the candidates for "almost the same answer" (net.ts `answer_diff` says how little changed) */
export function varied_answers(
	calls: readonly { method: string; url: string; status: number; start: number; body_hash?: string }[],
	runs: readonly { start: number; end: number }[]
): Set<string> {
	const out = new Set<string>();
	if (runs.length < 2) return out;
	const by = new Map<string, { runs: Set<number>; hashes: Set<string> }>();
	for (const c of calls) {
		if (c.method !== 'GET' || c.status < 200 || c.status >= 300 || !c.body_hash) continue;
		const run = runs.findIndex((r) => c.start >= r.start && c.start <= r.end);
		if (run === -1) continue;
		const k = `GET ${c.url}`;
		const g = by.get(k) ?? by.set(k, { runs: new Set(), hashes: new Set() }).get(k)!;
		g.runs.add(run);
		g.hashes.add(c.body_hash);
	}
	for (const [k, g] of by) if (g.runs.size === runs.length && g.hashes.size > 1) out.add(k);
	return out;
}

/**
 * THE SAME ANSWER, EVERY RENDER — the pattern: the calls of one render whose exact request (`stable`,
 * from `stable_answers`) answered the same bytes in every profiled render. Each place that makes one
 * is listed with what it waits, how big the answer is, and the line to cache at. The saving is what
 * comes off the render when the calls are answered from a cache: each one's end moves to its start,
 * except where another call (not cached) overlapped it and still sets the end — read off the
 * render's await graph when it holds the calls, else each call's own wait.
 */
export function find_same_answers(input: {
	calls: readonly WaitCall[];
	stable: ReadonlySet<string>;
	source?: SourceReader;
	awaits?: { nodes: AwaitNode[]; edges: AwaitEdge[] };
	w0?: number;
	/** ALMOST the same: the answers that differed between renders only in a small stretch, with that
	 *  stretch (`GET <url>` → text): the same cache, minus the part that changes */
	almost?: ReadonlyMap<string, string>;
}): Pattern | undefined {
	// ONE place per kind of request and the line that makes it: sixteen product ids fetched from one
	// line are one place ("16 URLs, each unchanged"), not sixteen rows
	const groups = new Map<string, WaitCall[]>();
	for (const c of input.calls) {
		if (!c.exact || !input.stable.has(c.exact) || !c.at || c.ms < 0) continue;
		const k = c.target + '\0' + c.at.path + ':' + c.at.line;
		(groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
	}
	if (!groups.size) return undefined;
	// what comes off the render: each cached call's stretch, less what an uncached call overlapping it
	// still holds (the render goes on only once that one is done too)
	const cached = [...groups.values()].flat();
	const on_path = (c: WaitCall): number => {
		const nodes = input.awaits?.nodes;
		if (!nodes?.length || input.w0 === undefined) return c.ms;
		const s = c.start - input.w0;
		const e = s + c.ms;
		let bound = s;
		for (const n of nodes) {
			if (n.t0 >= e || n.t1 <= s) continue;
			const is_cached = cached.some(
				(x) => Math.abs(x.start - input.w0! - n.t0) <= 0.6 && Math.abs(x.ms - (n.t1 - n.t0)) <= 1
			);
			if (is_cached) continue;
			bound = Math.max(bound, Math.min(n.t1, e));
		}
		return Math.max(0, e - bound);
	};
	const sites: PatternSite[] = [];
	let save = 0;
	for (const g of groups.values()) {
		const urls = new Set(g.map((c) => c.exact!));
		const wait = g.reduce((s, c) => s + c.ms, 0);
		const off = g.reduce((s, c) => s + on_path(c), 0);
		save += off;
		const at = g[0].at!;
		const code = input.source?.(at.path, at.line, at.line)?.lines[0]?.trim() ?? '';
		const asked = new Map<string, { path: string; line: number }>();
		for (const c of g) if (c.outer) asked.set(c.outer.path + ':' + c.outer.line, c.outer);
		const via: CallSite[] = [...asked.values()].slice(0, VIA_MAX).map((o) => {
			const oc = input.source?.(o.path, o.line, o.line)?.lines[0]?.trim() ?? '';
			return {
				path: o.path,
				file: short_file(o.path),
				line: o.line,
				code: oc.length > 140 ? oc.slice(0, 139) + '…' : oc,
				in_loop: false
			};
		});
		sites.push({
			path: at.path,
			file: short_file(at.path),
			line: at.line,
			code: code.length > 140 ? code.slice(0, 139) + '…' : code,
			cpu_ms: 0,
			alloc_bytes: 0,
			gc_ms: 0,
			calls: g.length,
			in_loop: false,
			wait_ms: r2(wait),
			// one URL: the request itself; several: their kind, with how many
			target: urls.size === 1 ? g[0].exact! : `${g[0].target} (${urls.size} URLs)`,
			...(g.some((c) => c.bytes !== undefined)
				? { answer_bytes: g.reduce((s, c) => s + (c.bytes ?? 0), 0) }
				: {}),
			...(g.some((c) => c.personal) ? { personal: true } : {}),
			// what the service itself says about keeping its answer
			...(() => {
				const rules = cache_rules(g.find((c) => c.cache)?.cache);
				return rules ? { upstream_cache: rules } : {};
			})(),
			...(via.length ? { via } : {}),
			...ctx_field(input.source, at.path, at.line)
		});
	}
	sites.sort((a, b) => (b.wait_ms ?? 0) - (a.wait_ms ?? 0));
	const cost = sites.reduce((s, x) => s + (x.wait_ms ?? 0), 0);
	if (save < MIN_SAVE_MS) return undefined;
	const top = sites[0];
	const personal = sites.filter((s) => s.personal).length;
	if (input.almost) {
		const changes =
			input.almost.get((top.target ?? '').split(' (')[0]) ?? [...input.almost.values()][0];
		return {
			kind: 'almost-same-answer',
			title: `Almost the same answer is fetched on every render${sites.length > 1 ? ` (${sites.length} places)` : ''}`,
			fix: `Every render asked for this and got the same answer back but for a small part that changes each time (${changes ? `\`${changes}\`` : 'a timestamp or an id'}): the data itself did not change. Cache the answer across requests like any unchanging one, and fill the changing part in yourself, or ask the API to leave it out (many add a request id or a generation time). If the changing part matters to the page, keep only that part live.`,
			example: {
				before: 'const catalog = await (await fetch(API + "/catalog")).json(); // { items, generatedAt }',
				after:
					'let cached, at = 0;\nif (Date.now() - at > 60_000) (cached = await (await fetch(API + "/catalog")).json()), (at = Date.now());\nconst catalog = { ...cached, generatedAt: new Date().toISOString() };'
			},
			sites,
			cost_ms: r2(cost),
			alloc_bytes: 0,
			save_ms: r2(save),
			evidence: `${top.target} answered the same in every render but for${changes ? ` \`${changes}\`` : ' a few bytes'}, ${r2(top.wait_ms ?? 0)} ms of waiting each time${sites.length > 1 ? `; ${sites.length - 1} more place${sites.length === 2 ? '' : 's'} do the same` : ''}`,
			wait: true
		};
	}
	return {
		kind: 'same-answer',
		title: `The same answer is fetched on every render${sites.length > 1 ? ` (${sites.length} places)` : ''}`,
		fix:
			'Every render asked for this and got the same bytes back each time: nothing it depends on changed between requests. Cache it across requests (a module-level cache with a time limit, the platform’s data cache, or a CDN in front of the API), refreshed on a schedule or when the data changes. If it must be fresh, ask the API for a cheaper “has it changed” check (ETag, If-None-Match) instead of the whole answer.' +
			(personal
				? ` ${personal === sites.length ? 'These requests' : `${personal} of these requests`} carried who is asking (a cookie or an authorization header), and the recording rendered as one user: cache ${personal === sites.length ? 'them' : 'those'} per user, keyed by the session, never for everyone.`
				: ''),
		example: {
			before:
				'export async function load({ fetch }) {\n\tconst config = await (await fetch(API + "/config")).json();',
			after:
				'let config_at = 0, config;\nexport async function load({ fetch }) {\n\tif (Date.now() - config_at > 60_000) (config = await (await fetch(API + "/config")).json()), (config_at = Date.now());'
		},
		sites,
		cost_ms: r2(cost),
		alloc_bytes: 0,
		save_ms: r2(save),
		evidence: `${top.target} answered the same ${top.answer_bytes !== undefined ? fmt_mb(top.answer_bytes) + ' ' : ''}in every render${top.personal ? ' (as the one user this recording rendered as)' : ''}, ${r2(top.wait_ms ?? 0)} ms of waiting each time${sites.length > 1 ? `; ${sites.length - 1} more place${sites.length === 2 ? '' : 's'} do the same` : ''}`,
		wait: true
	};
}

export interface PatternInput {
	ledger: readonly LedgerLine[];
	functions: readonly FrameStat[];
	/** lines `from`..`to` of a source file (1-based, inclusive), untrimmed */
	source?: SourceReader;
	/** how many renders the profile's CPU numbers add up (page mode's runs), for the wording */
	renders?: number;
	/** the V8 heap's limit and what is in use now, for a leak's countdown; `function`: the ceiling
	 *  is the serverless function's memory size (AWS Lambda), smaller than the heap, and what is in
	 *  use is the process's resident memory */
	heap?: { limit_bytes: number; used_bytes: number; function?: boolean };
	/** a few more renders with a collection after each: confirms a leak, or shows it levels off */
	growth?: HeapGrowth;
}

/** How many caller lines a wrapper site lists: enough to see the loop, never a wall */
const VIA_MAX = 4;

/** The lines that call `f` in its callers (its heaviest stacks' nearest app frame), found by name:
 *  its own name, what its module wraps it as (`const x = instrument(f)`), and what the caller's
 *  module imports those as. Each says whether that call runs inside a loop. */
function call_sites_of(
	f: FrameStat,
	by_loc: ReadonlyMap<string, FrameStat>,
	source: SourceReader
): CallSite[] {
	if (f.name.startsWith('(')) return [];
	const own = [f.name, ...(wrapper_aliases(source, f.path).get(f.name) ?? [])];
	const out: CallSite[] = [];
	const seen = new Set<string>();
	for (const st of f.stacks ?? []) {
		const fr = st.frames.find((x) => x.c === 'app' || x.c === 'component');
		if (!fr?.f || seen.has(fr.f)) continue;
		seen.add(fr.f);
		const caller = by_loc.get(fr.f);
		if (!caller || !caller.path || caller.line <= 0) continue;
		let names = own;
		if (caller.path !== f.path) {
			const imp = import_aliases(source, caller.path);
			names = [...own, ...own.flatMap((n) => imp.get(n) ?? [])];
		}
		const body = function_body(source, caller.path, caller.line);
		if (!body) continue;
		for (let i = 0; i < body.lines.length && out.length < VIA_MAX; i++) {
			if (!calls_name(body.lines[i], names)) continue;
			const line = body.start + i;
			const code = body.lines[i].trim();
			out.push({
				path: caller.path,
				file: caller.url,
				line,
				code: code.length > 140 ? code.slice(0, 139) + '…' : code,
				fn: caller.key,
				in_loop: loop_from(body.lines.slice(0, i + 1), caller.path.endsWith('.svelte')) >= 0
			});
		}
	}
	return out;
}

// ── reading the code ─────────────────────────────────────────────────────────

export { tokens };

/** `.name(` or `?.name(` in the tokens, at index `from` or later */
function calls_method(
	t: readonly string[],
	names: ReadonlySet<string>,
	from = 0
): string | undefined {
	for (let k = Math.max(0, from); k + 2 < t.length; k++) {
		if ((t[k] === '.' || t[k] === '?.') && names.has(t[k + 1]) && t[k + 2] === '(') return t[k + 1];
	}
	return undefined;
}

/** `new Name(` (or `new Intl.Name(` when `ns` is given) */
function constructs(
	t: readonly string[],
	names: ReadonlySet<string>,
	ns?: string
): string | undefined {
	for (let k = 0; k + 1 < t.length; k++) {
		if (t[k] !== 'new') continue;
		if (ns && t[k + 1] === ns && t[k + 2] === '.' && names.has(t[k + 3])) return t[k + 3];
		if (!ns && names.has(t[k + 1])) return t[k + 1];
	}
	return undefined;
}

/** a plain call `name(` not preceded by a `.` */
function calls_fn(t: readonly string[], names: ReadonlySet<string>): string | undefined {
	for (let k = 0; k + 1 < t.length; k++) {
		if (
			names.has(t[k]) &&
			t[k + 1] === '(' &&
			t[k - 1] !== '.' &&
			t[k - 1] !== '?.' &&
			t[k - 1] !== 'function'
		)
			return t[k];
	}
	return undefined;
}

/** `Array.from({ length: 60 }` — an array sized by a number literal */
function literal_length(t: readonly string[]): boolean {
	for (let k = 0; k + 7 < t.length; k++) {
		if (
			t[k] === 'Array' &&
			t[k + 1] === '.' &&
			t[k + 2] === 'from' &&
			t[k + 3] === '(' &&
			t[k + 4] === '{' &&
			t[k + 5] === 'length' &&
			t[k + 6] === ':' &&
			t[k + 7] === '0' &&
			t[k + 8] === '}'
		)
			return self_contained(t, k + 9);
	}
	return false;
}

/** names a fixed table's builder may use without depending on the call: builtins */
const GLOBALS: ReadonlySet<string> = new Set([
	'Math',
	'String',
	'Number',
	'JSON',
	'Object',
	'Array',
	'Boolean',
	'Symbol',
	'undefined',
	'null',
	'true',
	'false',
	'length'
]);

/** The callback that follows `from` (at or after token `k`) uses only its own parameters and
 *  builtins: nothing from the call it sits in (`(_, k) => \`t${i + k}\`` reads the outer `i`, so
 *  the table is NOT fixed). Property names (`.x`) and object keys (`x:`) are not reads. */
function self_contained(t: readonly string[], k: number): boolean {
	const arrow = t.indexOf('=>', k);
	if (arrow === -1) return true; // no callback: `Array.from({ length: 60 })` alone
	const params = new Set<string>();
	for (let j = k; j < arrow; j++) if (is_name(t[j])) params.add(t[j]);
	let depth = 0;
	for (let j = arrow + 1; j < t.length; j++) {
		const x = t[j];
		if (x === '(' || x === '{' || x === '[') depth++;
		else if (x === ')' || x === '}' || x === ']') depth--;
		if (!is_name(x) || params.has(x) || GLOBALS.has(x)) continue;
		if (t[j - 1] === '.' || t[j - 1] === '?.' || t[j + 1] === ':') continue;
		return false;
	}
	// the callback goes on past this line (`(_, r) => ({` …): its body is unseen, so unproven
	return depth <= 0;
}

const is_name = (x: string | undefined) =>
	!!x && x !== '""' && x !== '0' && is_word_start(x.charCodeAt(0));
const is_word_start = (c: number) =>
	(c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127;

/** the identifier a method is called on: `html` in `html.replace(` (from token `from` on) */
function receiver_of(t: readonly string[], method: string, from: number): string | undefined {
	for (let k = Math.max(1, from); k + 1 < t.length; k++)
		if (t[k] === method && (t[k - 1] === '.' || t[k - 1] === '?.')) return t[k - 2];
	return undefined;
}

/** `name = …` or `name += …` on any of the token lines */
function reassigned(name: string | undefined, lines: readonly (readonly string[])[]): boolean {
	if (!name) return false;
	for (const t of lines)
		for (let k = 0; k + 1 < t.length; k++)
			if (t[k] === name && (t[k + 1] === '=' || t[k + 1] === '+=') && t[k - 1] !== '.') return true;
	return false;
}

/** `A . b` in sequence */
/** the formatter on this line is built only when a cache MISSES — the fix itself, the shape this
 *  profiler's own written change has: `if (!f) cache.set(key, (f = new Intl.X(…)))`, `f ??= new
 *  Intl.X(…)`, `cache.get(k) ?? cache.set(k, new Intl.X(…))`. Its time is the first build per key,
 *  not a build per call */
function built_on_miss(t: readonly string[]): boolean {
	const k = t.findIndex((x, i) => x === 'new' && t[i + 1] === 'Intl');
	if (k === -1) return false;
	const before = t.slice(0, k);
	if (before.includes('??=') || before.includes('||=') || before.includes('??')) return true;
	// `if (!f) …` / `if (!cache.has(k)) …`
	if (before[0] === 'if' && before[1] === '(' && before[2] === '!') return true;
	// stored as it is built: inside the argument list of a `.set(`
	let depth = 0;
	for (let i = k - 1; i >= 0; i--) {
		if (t[i] === ')') depth++;
		else if (t[i] === '(') {
			if (depth === 0 && t[i - 1] === 'set' && t[i - 2] === '.') return true;
			if (depth > 0) depth--;
		}
	}
	return false;
}

/** calls whose answer is text: added with `+=`, they grow a string */
const TEXT_CALLS: ReadonlySet<string> = new Set([
	'String',
	'join',
	'toString',
	'toFixed',
	'padStart',
	'padEnd',
	'repeat',
	'stringify',
	'slice',
	'substring',
	'trim',
	'replace',
	'replaceAll',
	'toUpperCase',
	'toLowerCase',
	'toISOString',
	'esc',
	'escape'
]);

/** a `+=` at or after `from` that adds TEXT: a string or template literal, or a call answering
 *  text, at the top level of what is added (`out += '<li>' + x`). Not a sum of numbers — `s +=
 *  (JSON.stringify(x).length) % 7` adds a number, though a string call sits inside it */
function grows_text(
	t: readonly string[],
	from: number,
	text: ReadonlySet<string> = new Set()
): boolean {
	for (let k = t.indexOf('+=', Math.max(0, from)); k !== -1; k = t.indexOf('+=', k + 1)) {
		// the target was made text above (`let out = ''`)
		if (text.has(t[k - 1]) && t[k - 2] !== '.') return true;
		let d = 0;
		for (let j = k + 1; j < t.length && t[j] !== ';'; j++) {
			const x = t[j];
			if (x === '(' || x === '[' || x === '{') {
				d++;
				continue;
			}
			if (x === ')' || x === ']' || x === '}') {
				if (--d < 0) break;
				continue;
			}
			if (d !== 0) continue;
			if (x === '""') return true;
			// `.length` after a call: a number, whatever the call was
			if (TEXT_CALLS.has(x) && t[j + 1] === '(') {
				let e = j + 1;
				for (let dd = 0; e < t.length; e++) {
					if (t[e] === '(') dd++;
					else if (t[e] === ')' && --dd === 0) break;
				}
				if (t[e + 1] !== '.') return true;
			}
		}
	}
	return false;
}

function has_member(t: readonly string[], obj: string, prop: string): boolean {
	for (let k = 0; k + 2 < t.length; k++)
		if (t[k] === obj && t[k + 1] === '.' && t[k + 2] === prop) return true;
	return false;
}

const LOOP_METHODS: ReadonlySet<string> = new Set([
	'forEach',
	'map',
	'flatMap',
	'reduce',
	'reduceRight',
	'filter',
	'some',
	'every',
	'find',
	'findIndex'
]);

/** Where the LAST line of `lines` (a function's body, from its first line) runs in a loop: the
 *  token index on that line from which code is inside one. 0 when the whole line is (an enclosing
 *  loop body), the index after a loop header on the line itself (`for (…) x = f(x)`, `xs.map(`),
 *  -1 when none of it is. Tracks brace blocks: a block opened after a loop header (`for`, `while`,
 *  `do`, a `.map(` / `.forEach(` callback) is a loop body. A Svelte file counts `{#each}` too. */
export function loop_from(lines: readonly string[], svelte = false): number {
	const blocks: boolean[] = [];
	let pending = false;
	let paren = 0;
	let each = 0;
	for (let li = 0; li < lines.length; li++) {
		const t = tokens(lines[li]);
		const last = li === lines.length - 1;
		// the last line starts inside a loop: all of it runs per item
		if (last && (pending || each > 0 || blocks.includes(true))) return 0;
		for (let k = 0; k < t.length; k++) {
			const x = t[k];
			if (svelte && x === '{' && (t[k + 1] === '#' || t[k + 1] === '/') && t[k + 2] === 'each') {
				each = Math.max(0, each + (t[k + 1] === '#' ? 1 : -1));
				// the block tag's own brace pair is not a JS block
				while (k < t.length && t[k] !== '}') k++;
				continue;
			}
			// a loop header on the line itself: what follows it on the line is the loop's body
			if (x === 'for' || x === 'while' || x === 'do') {
				if (last) return k + 1;
				pending = true;
			} else if ((x === '.' || x === '?.') && LOOP_METHODS.has(t[k + 1]) && t[k + 2] === '(') {
				if (last) return k + 3;
				pending = true;
			} else if (x === '(') paren++;
			else if (x === ')') paren = Math.max(0, paren - 1);
			else if (x === '{') {
				const outer = blocks[blocks.length - 1] === true;
				// a code block follows `)` (for / if / function), `=>`, or a keyword; any other brace is
				// an object literal or a destructuring pattern, which neither opens nor ends a loop body
				const prev = t[k - 1];
				const block =
					prev === ')' ||
					prev === '=>' ||
					prev === 'else' ||
					prev === 'do' ||
					prev === 'try' ||
					prev === 'finally' ||
					(k === 0 && pending);
				if (block) {
					blocks.push(pending || outer);
					pending = false;
				} else blocks.push(outer);
			} else if (x === '}') blocks.pop();
			else if (x === ';' && paren === 0) pending = false;
		}
	}
	return -1;
}

/**
 * ONE LINE, CALLS ONE AFTER ANOTHER: independent only when the line runs in a loop (`for (…) await
 * fetch(…)`, a loop body a few lines up). Otherwise the line nests them (`f(await g(await h()))`:
 * a build without maps folds single-use constants into one such line) or its code is not the
 * code that ran: never a missed `Promise.all`.
 */
function loops_here(source: SourceReader, path: string, line: number): boolean {
	const w = source(path, Math.max(1, line - 20), line);
	if (!w?.lines.length) return false;
	return loop_from(w.lines) >= 0;
}

/** Does any of the last line of `lines` run inside a loop? (`loop_from` ≥ 0) */
export const in_loop = (lines: readonly string[], svelte = false): boolean =>
	loop_from(lines, svelte) >= 0;

/** the line sits in a Svelte `<script module>` (runs once per module, not per render) */
function in_module_script(lines: readonly string[]): boolean {
	let inside = false;
	for (const l of lines) {
		// the tag starts its line; `<script module>` in a comment or a string is not one
		const s = l.trimStart();
		if (s.startsWith('<script'))
			inside = s.slice(0, s.indexOf('>') + 1 || undefined).includes('module');
		if (s.startsWith('</script>')) inside = false;
	}
	return inside;
}

// ── the patterns ─────────────────────────────────────────────────────────────

const INTL: ReadonlySet<string> = new Set([
	'NumberFormat',
	'DateTimeFormat',
	'Collator',
	'PluralRules',
	'RelativeTimeFormat',
	'ListFormat',
	'Segmenter',
	'DisplayNames'
]);
const LOCALE_METHODS: ReadonlySet<string> = new Set([
	'toLocaleString',
	'toLocaleDateString',
	'toLocaleTimeString',
	'localeCompare'
]);
const RESCAN: ReadonlySet<string> = new Set([
	'replace',
	'replaceAll',
	'split',
	'indexOf',
	'lastIndexOf',
	'includes',
	'match',
	'matchAll',
	'search',
	'slice',
	'substring',
	'concat',
	'trim',
	'toLowerCase',
	'toUpperCase'
]);
const STRING_REBUILD: ReadonlySet<string> = new Set([
	'replace',
	'replaceAll',
	'slice',
	'substring',
	'concat'
]);
const LOOKUP: ReadonlySet<string> = new Set([
	'find',
	'findIndex',
	'findLast',
	'filter',
	'indexOf',
	'includes',
	'some'
]);
const TABLE_BUILDERS: ReadonlySet<string> = new Set(['fromEntries', 'from']);
const COLLECTIONS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap']);
const SORT: ReadonlySet<string> = new Set(['sort', 'toSorted']);
const SYNC_IO: ReadonlySet<string> = new Set([
	'readFileSync',
	'writeFileSync',
	'existsSync',
	'statSync',
	'lstatSync',
	'readdirSync',
	'execSync',
	'spawnSync',
	'accessSync',
	'realpathSync'
]);
const REGEXP: ReadonlySet<string> = new Set(['RegExp']);
const DATE: ReadonlySet<string> = new Set(['Date']);
const CLONE: ReadonlySet<string> = new Set(['structuredClone', 'cloneDeep']);
const YIELDS: ReadonlySet<string> = new Set(['setImmediate', 'setTimeout', 'queueMicrotask']);

interface Rule {
	kind: PatternKind;
	/** share of the measured cost a fix gives back (rough) */
	saves: number;
	title: (n: number, sites: readonly PatternSite[]) => string;
	fix: string;
	example?: { before: string; after: string };
	/** does this line, in this context, have the shape? */
	match: (t: readonly string[], ctx: Ctx) => boolean;
}

interface Ctx {
	loop: boolean;
	/** the token index on the line from which code runs per item (`loop_from`), -1 for none */
	from: number;
	/** the function ran more than once (V8's count), or its line is in a loop */
	repeated: boolean;
	svelte: boolean;
	module_scope: boolean;
	cpu_ms: number;
	alloc_bytes: number;
	/** of cpu_ms, the part spent inside libraries this line called */
	lib_ms: number;
	/** of lib_ms, the part inside packages (not Node's own functions) */
	pkg_ms: number;
	/** the library functions the line called (their own names) */
	lib_names: readonly string[];
	/** of lib_ms, the part inside a regular expression's own compiled code (`RegExp: …` frames) */
	regex_ms: number;
	/** one of those patterns can backtrack hard (`backtracks`) */
	regex_backtracks: boolean;
	/** a regex literal written on the line can backtrack hard: V8 may run such a pattern in a mode
	 *  that charges its time to the line itself (no `RegExp:` frame) */
	literal_backtracks: boolean;
	/** the line's CPU per call of its function in one render, when V8 counted the calls */
	per_call_ms?: number;
	/** the line's allocation per call of its function in one render, likewise */
	per_call_bytes?: number;
	/** the line's allocation in one render */
	alloc_per_render: number;
	/** names the function built a formatter into above this line (`intl_locals`) */
	intl_locals: ReadonlySet<string>;
	/** names the function made TEXT above this line (`let out = ''`, `let html: string`) */
	text_locals: ReadonlySet<string>;
	/** names the function built a RegExp into above this line, each with the line that built it */
	regexp_locals: ReadonlyMap<string, { line: number; code: string }>;
	/** the next few source lines (a value scanned here and reassigned just below) */
	after: readonly string[];
}

const MB = 1024 * 1024;
/** the smallest estimated saving a pattern must offer to be reported, ms */
const MIN_SAVE_MS = 1;
const places = (n: number) => (n === 1 ? '' : ` (${n} places)`);
/** one run of a pattern this slow is worth a card on its own (a cheap one runs in about a µs) */
const SLOW_REGEX_RUN_MS = 0.02;
/** the pattern a site's line ran, from its library callees (`RegExp: ^(\w+\s?)*$ (Node)`) */
const regex_of = (s: PatternSite): string | undefined => {
	const lib = s.libs?.find((x) => x.startsWith(REGEXP_FRAME));
	if (!lib) return undefined;
	const src = lib.slice(REGEXP_FRAME.length);
	return src.endsWith(' (Node)') ? src.slice(0, -' (Node)'.length) : src;
};

/** the names in a function body that hold a formatter built right there: `const rules = new Intl.PluralRules(…)` */
function intl_locals(body: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const line of body) {
		const t = tokens(line);
		// (built only when a cache misses: its use below is the cheap part, not a build per call)
		if (built_on_miss(t)) continue;
		for (let k = 0; k + 4 < t.length; k++)
			if (t[k + 1] === '=' && t[k + 2] === 'new' && t[k + 3] === 'Intl') out.add(t[k]);
	}
	return out;
}
/** the names in a function body that hold a RegExp built right there (`const re = new RegExp(…)`),
 *  each with its line: `first` is the body's first line number */
function regexp_locals(body: readonly string[], first: number): Map<string, { line: number; code: string }> {
	const out = new Map<string, { line: number; code: string }>();
	for (let i = 0; i < body.length; i++) {
		// (a cheap test before tokenizing every line of the body)
		if (!body[i].includes('RegExp')) continue;
		const t = tokens(body[i]);
		for (let k = 0; k + 3 < t.length; k++)
			if (t[k + 1] === '=' && ((t[k + 2] === 'new' && t[k + 3] === 'RegExp') || (t[k + 2] === 'RegExp' && t[k + 3] === '(')))
				out.set(t[k], { line: first + i, code: body[i].trim() });
	}
	return out;
}
/** (a check, whose own ticks are the build's: a `replace` or a `split` with it makes new text, work
 *  that stays after the fix — its line is not moved) */
const REGEXP_USE: ReadonlySet<string> = new Set(['test', 'exec']);
/** the RegExp the same function built that this line checks with: `re.test(s)`, `re.exec(s)` — V8
 *  often charges a `new RegExp` to its first use, the line below it */
function used_local_regexp(t: readonly string[], locals: ReadonlyMap<string, { line: number; code: string }>): { line: number; code: string } | undefined {
	if (!locals.size) return undefined;
	for (let k = 0; k + 3 < t.length; k++) {
		const at = locals.get(t[k]);
		if (at && t[k + 1] === '.' && REGEXP_USE.has(t[k + 2]) && t[k + 3] === '(') return at;
	}
	return undefined;
}
/** the names in a function body declared as text: `let out = ''`, `` let html = `<ul>` ``, `let s: string` */
function text_locals(body: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const line of body) {
		const t = tokens(line);
		for (let k = 0; k + 2 < t.length; k++) {
			if (t[k] !== 'let' && t[k] !== 'var') continue;
			if (t[k + 2] === '=' && t[k + 3] === '""') out.add(t[k + 1]);
			else if (t[k + 2] === ':' && t[k + 3] === 'string') out.add(t[k + 1]);
		}
	}
	return out;
}
const INTL_USE: ReadonlySet<string> = new Set([
	'format',
	'formatToParts',
	'formatRange',
	'select',
	'selectRange',
	'compare',
	'of',
	'segment'
]);

/** A locale method given a locale or options (`n.toLocaleString('de')`, `a.localeCompare(b, 'de', …)`):
 *  that builds a formatter inside on every call. With no locale (`a.localeCompare(b)`,
 *  `n.toLocaleString()`) V8 reuses its cached default one, which is cheap. */
function locale_call_with_args(t: readonly string[]): boolean {
	for (let k = 0; k + 2 < t.length; k++) {
		if ((t[k] !== '.' && t[k] !== '?.') || !LOCALE_METHODS.has(t[k + 1]) || t[k + 2] !== '(')
			continue;
		// arguments at depth 1: localeCompare's first is the other string, so it needs two
		const needs = t[k + 1] === 'localeCompare' ? 2 : 1;
		let depth = 0;
		let args = 0;
		let any = false;
		for (let j = k + 2; j < t.length; j++) {
			const x = t[j];
			if (x === '(' || x === '[' || x === '{') depth++;
			else if (x === ')' || x === ']' || x === '}') {
				if (--depth === 0) break;
			} else if (depth === 1) {
				if (x === ',') args++;
				else if (!any) ((any = true), args++);
			}
		}
		if (args >= needs) return true;
	}
	return false;
}

/** the line calls a method of a formatter the same function built: `rules.select(n)` */
function uses_local_intl(t: readonly string[], locals: ReadonlySet<string>): boolean {
	if (!locals.size) return false;
	for (let k = 0; k + 3 < t.length; k++)
		if (locals.has(t[k]) && t[k + 1] === '.' && INTL_USE.has(t[k + 2]) && t[k + 3] === '(')
			return true;
	return false;
}

// ordered most specific first: a line takes the first rule it matches
const RULES: Rule[] = [
	{
		kind: 'formatter-per-call',
		saves: 0.9,
		title: (n) => `A new number or date formatter is built on every call${places(n)}`,
		fix: 'Building an Intl formatter is slow; using one is fast. Make it once per locale and reuse it, for example in a Map keyed by locale and options.',
		example: {
			before: 'return new Intl.NumberFormat(locale, opts).format(n);',
			after:
				'const fmts = new Map();\nconst fmt = (locale) => fmts.get(locale) ?? fmts.set(locale, new Intl.NumberFormat(locale, opts)).get(locale);\nreturn fmt(locale).format(n);'
		},
		// the build itself, a locale method (builds one inside), or the first USE of a formatter the
		// same function just built: V8 often charges the construction to the line that uses it
		match: (t, c) =>
			c.repeated &&
			((!!constructs(t, INTL, 'Intl') && !built_on_miss(t)) ||
				locale_call_with_args(t) ||
				uses_local_intl(t, c.intl_locals))
	},
	{
		kind: 'scan-for-key',
		saves: 0.9,
		title: (n) => `A key is found by walking every entry${places(n)}`,
		fix: 'Walking Object.entries / Object.keys to find one key reads the whole table and builds a new array every time. Read it directly (table[key]), or keep the table in a Map.',
		example: {
			before: 'for (const [k, v] of Object.entries(table)) if (k === key) return v;',
			after: 'return Object.hasOwn(table, key) ? table[key] : undefined;'
		},
		match: (t, c) => {
			if (c.cpu_ms < 0.5 && c.alloc_bytes < MB) return false;
			const walks = has_member(t, 'Object', 'entries') || has_member(t, 'Object', 'keys');
			if (!walks) return false;
			// walked in a `for` and compared, or searched with a find/some/filter/includes
			// (`===` tokenizes as `==` `=`)
			return (t.includes('for') && t.includes('==')) || !!calls_method(t, LOOKUP);
		}
	},
	{
		// before the rescan rule: `new RegExp(term.replace(…))` is the compile, not a big string
		kind: 'regexp-per-call',
		saves: 0.7,
		title: (n) => `A regular expression is built on every call${places(n)}`,
		// V8 caches a compiled pattern by its text and flags, so a repeat is not a recompile: what each
		// call pays is a new RegExp object, the escaping that often builds its text, and a cache lookup
		fix: 'Each call builds a new RegExp (and often escapes its text first). V8 reuses the compiled pattern when the text repeats, so each call is cheap, but it runs once per item; the time measured here is what building it once saves. A fixed pattern: build it outside the function. One per request, like a search term: build it once where the term arrives and pass the RegExp in.',
		example: {
			before: 'const hits = items.filter((p) => new RegExp(escape(term), "i").test(p.name));',
			after:
				'const re = new RegExp(escape(term), "i"); // once per request\nconst hits = items.filter((p) => re.test(p.name));'
		},
		// (or the line that first runs it, below: the build's time is often charged there — the site
		// is moved to the build's own line)
		match: (t, c) => c.repeated && (!!constructs(t, REGEXP) || !!used_local_regexp(t, c.regexp_locals))
	},
	{
		// the time is INSIDE the pattern: V8 runs a compiled regex as its own code (`RegExp: <source>`
		// in the profile), charged to the line that runs it. Building it is the rule above
		kind: 'slow-regex',
		saves: 0.8,
		title: (n, sites) =>
			sites.some((s) => backtracks(regex_of(s)) || regex_literals(s.code).some(backtracks))
				? `A regular expression can backtrack, and runs slowly${places(n)}`
				: `A regular expression takes long to run${places(n)}`,
		fix: 'The time is inside the pattern itself. A repeat inside another repeat (`(\\w+\\s?)*`, `(a|aa)+`) makes the engine try every way to split the text before it gives up, and that grows fast with the text. Rewrite it so each character can match only one way (`\\w+(?:\\s\\w+)*`), anchor it, or cap how long the text may be. Often a plain check (`includes`, `startsWith`, one `split`) is all the pattern was for.',
		example: {
			before: 'const ok = /^(\\w+\\s?)*$/.test(title);',
			after: 'const ok = /^\\w+(?:\\s\\w+)*$/.test(title);'
		},
		// a cheap pattern run many times is not this (a vowel swap over 10 000 names: no rewrite of the
		// pattern helps): a pattern that can backtrack, or one whose single run is slow. In a loop
		// the function's call count is not the pattern's (one call runs it per item): backtracking only
		match: (_t, c) =>
			(c.literal_backtracks && c.cpu_ms >= 0.5) ||
			(c.regex_ms >= 0.5 &&
				c.regex_ms >= c.cpu_ms * 0.3 &&
				(c.regex_backtracks ||
					(!c.loop &&
						(c.per_call_ms === undefined ||
							c.per_call_ms * (c.regex_ms / c.cpu_ms) >= SLOW_REGEX_RUN_MS))))
	},
	{
		kind: 'rescan-in-loop',
		// N passes become one: all but a sliver (the /hell-fixed walk: 81 ms of rescans → 2)
		saves: 0.9,
		title: (n) => `The whole string is scanned and copied once per item${places(n)}`,
		fix: 'Each pass reads the full string and, for a replace, builds a new copy of it. Do one pass: find every spot first, then build the result once (collect the parts in an array and join them, or use one replace with a callback that looks each match up in a Map).',
		example: {
			before: 'for (const { tag, el } of items) html = html.replace(tag, el);',
			after:
				'const by_tag = new Map(items.map((i) => [i.tag, i.el]));\nhtml = html.replace(TAGS, (m) => by_tag.get(m) ?? m);'
		},
		match: (t, c) => {
			if (!c.loop) return false;
			const m = calls_method(t, RESCAN, c.from);
			if (!m) return false;
			// a read-only string call next to a list searched inside a callback
			// (`.split(…).filter((c, i, a) => a.indexOf(c) === i)`): the search is the cost, not the string
			const cb = t.indexOf('=>', c.from);
			if (!STRING_REBUILD.has(m) && cb !== -1 && calls_method(t, LOOKUP, cb)) return false;
			// a rebuild of the same big string is the expensive shape; otherwise the string scanned
			// must be the one being rebuilt (reassigned here or on the next lines: `html = …`) — a
			// short value cleaned per item (`key.replace(/_/g, ' ')`) is not "the whole string"
			// (each call's share big too: 3 000 names each cleaned by one replace add up to a MB of
			// small strings, not one big string copied again)
			return (
				(STRING_REBUILD.has(m) &&
					c.alloc_bytes >= MB &&
					(c.per_call_bytes !== undefined
						? c.per_call_bytes >= 16 * 1024
						: // no count to divide by: only a size no pile of small values reaches
							c.alloc_per_render >= 4 * MB)) ||
				(c.cpu_ms >= 1 && reassigned(receiver_of(t, m, c.from), [t, ...c.after.map(tokens)]))
			);
		}
	},
	{
		kind: 'lookup-in-loop',
		saves: 0.75,
		title: (n) => `A list is searched from the start for every item${places(n)}`,
		fix: 'A find / filter / includes inside a loop reads the whole list each time, so the work grows with the square of the list. Build a Map or Set once before the loop and look items up by key.',
		example: {
			before: 'for (const p of products) p.brand = brands.find((b) => b.id === p.brand_id);',
			after:
				'const by_id = new Map(brands.map((b) => [b.id, b]));\nfor (const p of products) p.brand = by_id.get(p.brand_id);'
		},
		match: (t, c) => c.loop && c.cpu_ms >= 0.5 && !!calls_method(t, LOOKUP, c.from)
	},
	{
		kind: 'table-per-call',
		saves: 0.9,
		title: (n) => `The same fixed table is rebuilt on every call${places(n)}`,
		fix: 'This line builds a lookup table, list or set from fixed data each time the function (or component) runs. Move it outside the function so it is built once. In a Svelte component, put it in <script module>.',
		match: (t, c) => {
			if (!c.repeated || c.module_scope) return false;
			if (c.alloc_bytes < 256 * 1024 && c.cpu_ms < 0.5) return false;
			// FIXED means sized by a literal (`{ length: 60 }`) or built from a literal list: a table
			// sized by the input (`{ length: m + 1 }`, a DP matrix) is real per-call work
			if (
				literal_length(t) ||
				(has_member(t, 'Object', 'fromEntries') && t[t.indexOf('fromEntries') + 2] === '[')
			)
				return true;
			const col = constructs(t, COLLECTIONS);
			if (col) {
				const k = t.indexOf(col);
				return t[k + 1] === '(' && t[k + 2] === '[';
			}
			// `'a b c'.split(' ')`: a literal list split each time
			for (let k = 0; k + 3 < t.length; k++)
				if (t[k] === '""' && t[k + 1] === '.' && t[k + 2] === 'split') return true;
			return false;
		}
	},
	{
		kind: 'deep-copy',
		saves: 0.8,
		title: (n) => `A whole object is deep-copied${places(n)}`,
		fix: 'JSON.parse(JSON.stringify(x)) and structuredClone copy every field, every time. Copy only what you change, or avoid the copy by not mutating the original.',
		match: (t, c) =>
			(c.cpu_ms >= 0.5 || c.alloc_bytes >= MB) &&
			((has_member(t, 'JSON', 'parse') && has_member(t, 'JSON', 'stringify')) ||
				!!calls_fn(t, CLONE) ||
				!!calls_method(t, CLONE))
	},
	{
		kind: 'spread-accumulate',
		saves: 0.8,
		title: (n) => `A list or object is copied on each step of a loop${places(n)}`,
		fix: 'Spreading the accumulator ([...acc, x] or {...acc, k: v}) copies everything built so far at every step, so the work grows with the square of the size. Push into one array, or set keys on one object.',
		example: {
			before: 'items.reduce((acc, i) => ({ ...acc, [i.id]: i }), {})',
			after: 'const acc = {};\nfor (const i of items) acc[i.id] = i;'
		},
		match: (t, c) => {
			if (!(c.loop || t.includes('reduce'))) return false;
			if (c.alloc_bytes < 256 * 1024 && c.cpu_ms < 0.5) return false;
			// a statement a bundler (or a formatter) broke after the opening bracket: `reduce((acc, p)
			// => ({` here, `...acc,` on the next line — read as one
			const last = t[t.length - 1];
			const all =
				(last === '(' || last === '{' || last === '[') && c.after[0] !== undefined
					? [...t, ...tokens(c.after[0])]
					: t;
			// THE ACCUMULATOR, not any spread: the reduce callback's first parameter (`reduce((acc, i)
			// => ({ ...acc, … }))`), or the name the line assigns (`acc = [...acc, x]`). Spreading an
			// item into a new object (`items.map((i) => ({ ...i, price }))`) or a call's arguments
			// (`out.push(...chunk)`, `Math.max(...xs)`) copies one item, not everything built so far
			const acc = new Set<string>();
			for (let k = 0; k + 3 < all.length; k++)
				if (
					all[k] === 'reduce' &&
					all[k + 1] === '(' &&
					all[k + 2] === '(' &&
					is_word_start((all[k + 3] ?? '').charCodeAt(0))
				)
					acc.add(all[k + 3]);
			for (let k = 1; k < all.length; k++)
				if (
					(all[k] === '=' || all[k] === '+=') &&
					is_word_start((all[k - 1] ?? '').charCodeAt(0)) &&
					all[k - 2] !== '.'
				)
					acc.add(all[k - 1]);
			for (let k = 0; k + 2 < all.length; k++)
				if ((all[k] === '[' || all[k] === '{') && all[k + 1] === '...' && acc.has(all[k + 2]))
					return true;
			return false;
		}
	},
	{
		kind: 'string-build',
		saves: 0.5,
		title: (n) => `A big string is grown piece by piece in a loop${places(n)}`,
		fix: 'Each += on a long string can copy it. Collect the pieces in an array and join once at the end.',
		match: (t, c) => c.loop && c.alloc_bytes >= MB && grows_text(t, c.from, c.text_locals)
	},
	{
		kind: 'sort-per-call',
		saves: 0.7,
		title: (n) => `A list is sorted on every call${places(n)}`,
		fix: 'Sort once where the data is loaded (or cache the sorted list) and pass it down, instead of sorting each time this runs.',
		match: (t, c) => c.repeated && c.cpu_ms >= 0.5 && !!calls_method(t, SORT)
	},
	{
		kind: 'date-parse',
		saves: 0.6,
		title: (n) => `Dates are parsed from text over and over${places(n)}`,
		fix: 'Parsing a date string is slow. Parse once when the data arrives and keep the timestamp as a number.',
		match: (t, c) => {
			if (!c.repeated || c.cpu_ms < 0.5) return false;
			if (has_member(t, 'Date', 'parse')) return true;
			if (constructs(t, DATE) !== 'Date') return false;
			// `new Date(x)` parses only when x is text: a number or arithmetic (`t0 + i * DAY`) is not
			const open = t.indexOf('Date', t.indexOf('new')) + 1;
			if (t[open] !== '(' || t[open + 1] === ')') return false;
			let depth = 0;
			for (let j = open; j < t.length; j++) {
				const x = t[j];
				if (x === '(') depth++;
				else if (x === ')' && --depth === 0) break;
				else if (x === '0' || x === '+' || x === '-' || x === '*' || x === '/' || x === ',')
					return false;
			}
			return true;
		}
	},
	{
		kind: 'sync-io',
		saves: 0.9,
		title: (n) => `The render waits on the disk${places(n)}`,
		fix: 'A *Sync file or process call blocks every request on this server while it runs. Read it once at startup, or use the async version.',
		match: (t, c) => c.cpu_ms >= 0.2 && !!calls_fn(t, SYNC_IO)
	},
	{
		kind: 'yield-per-item',
		// yielding every few hundred turns keeps one in hundreds (/hell-fixed: 20 ms → under 1)
		saves: 0.9,
		title: (n) => `The loop waits for the event loop on every turn${places(n)}`,
		fix: 'Each await on a timer (setImmediate, setTimeout, nextTick) hands the thread back and waits to be scheduled again, once per item. If the loop must yield, yield every few hundred items, or do the work in one pass.',
		example: {
			before: 'for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));',
			after:
				'for (let i = 0; i < n; i++) {\n\twork(i);\n\tif (i % 500 === 499) await new Promise((r) => setImmediate(r));\n}'
		},
		match: (t, c) =>
			c.loop && c.cpu_ms >= 1 && (!!calls_fn(t, YIELDS) || has_member(t, 'process', 'nextTick'))
	},
	{
		// the general case, last: a library call on a line that runs per item, when no more specific
		// shape (a deep copy, a formatter) already explains it
		kind: 'library-per-item',
		saves: 0.5,
		title: (n, sites) => {
			const lib = sites[0]?.libs?.[0];
			return lib
				? `${lib} is called once per item${places(n)}`
				: `A library is called once per item${places(n)}`;
		},
		fix: 'Every call pays the library’s full cost again. If many items share the same input, cache the result by input. If the library can take them all at once, call it once for the whole batch. Skip items that do not need it.',
		example: {
			before: 'await Promise.all(tags.map((tag) => render(tag)));',
			after:
				'const cache = new Map();\nconst once = (tag) => cache.get(tag) ?? cache.set(tag, render(tag)).get(tag);\nawait Promise.all(tags.map(once));'
		},
		// (Node's own functions — a timer, a socket write — are the runtime, not a library to batch or
		// cache: `await new Promise((r) => setTimeout(r, ms))` is not "a library per item")
		match: (_t, c) => c.pkg_ms >= 2 && c.repeated
	}
];

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * SYNC I/O TOO QUICK TO SAMPLE: a small file read on every request finishes under the CPU
 * sampler's interval, so no sample lands on it, yet it blocks every other request on the server
 * while the disk answers (a cold disk or a bigger file makes it long). V8's call counts (the
 * coverage render) count Node's own `readFileSync` like any function: a *Sync call counted in the
 * render, at a line of the route's own files inside a function the render ran (counted too), is
 * one. Module top-level code runs once at start-up and is left out. Pure: the counts and the files'
 * text in, the pattern out (undefined when nothing qualifies). No regex.
 */
export function counted_sync_io(counts: Readonly<Record<string, number>>, files: readonly { path: string; file: string; text: string }[]): Pattern | undefined {
	const sync = new Map<string, number>();
	const ran = new Set<string>();
	for (const [k, n] of Object.entries(counts)) {
		const z = k.indexOf('\0');
		if (z === -1 || n <= 0) continue;
		const name = k.slice(0, z);
		const where = k.slice(z + 1);
		if (where.startsWith('node:')) {
			if (COUNTED_SYNC.has(name)) sync.set(name, Math.max(sync.get(name) ?? 0, n));
		} else ran.add(name);
	}
	if (!sync.size) return undefined;
	const names = [...sync.keys()];
	const sites: PatternSite[] = [];
	for (const f of files) {
		const lines = f.text.split('\n');
		// the enclosing functions' names, one per open brace (null: a block that is not a function's)
		const stack: (string | null)[] = [];
		let in_comment = false;
		for (let i = 0; i < lines.length && sites.length < 6; i++) {
			const raw = lines[i];
			if (in_comment) {
				if (raw.includes('*/')) in_comment = false;
				continue;
			}
			const trimmed = raw.trimStart();
			if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
				in_comment = true;
				continue;
			}
			const t = tokens(raw);
			// the line's own name for a function it opens: `function x(`, `const x = (…) =>`, `x(…) {`
			let named: string | null = null;
			const fn_at = t.indexOf('function');
			if (fn_at !== -1) named = t[fn_at + 1] === '*' ? (t[fn_at + 2] ?? null) : (t[fn_at + 1] ?? null);
			else {
				const decl = t.findIndex((x) => x === 'const' || x === 'let' || x === 'var');
				const eq = decl === -1 ? -1 : t.indexOf('=', decl);
				if (eq !== -1) {
					// `= (…) =>` / `= async (…) =>` / `= x =>`: a function; `= items.map((y) => {` is not
					const j = t[eq + 1] === 'async' ? eq + 2 : eq + 1;
					const to = t.indexOf('=>', j);
					if (to !== -1 && (t[j] === '(' || to === j + 1) && !t.slice(j, to).includes('.')) named = t[decl + 1] ?? null;
				} else if (t.length > 2 && t[1] === '(' && t[t.length - 1] === '{' && !BLOCK_WORDS.has(t[0])) named = t[0];
			}
			let arrow = false;
			for (let k = 0; k < t.length; k++) {
				const x = t[k];
				if (x === '{') stack.push(named);
				else if (x === '}') stack.pop();
				else if (x === '=>') arrow = true;
				else if (t[k + 1] === '(' && names.includes(x) && t[k - 1] !== 'function') {
					// inside a function: an open brace (a block of one), or a braceless arrow on this line
					// (a block no function encloses — a top-level `if` — runs at start-up too)
					let fn: string | null = null;
					for (let s = stack.length - 1; s >= 0 && !fn; s--) fn = stack[s];
					if (!fn && arrow) fn = named;
					// (the function it sits in ran in the render: a helper never called is not this page's)
					if (!fn || !ran.has(fn)) continue;
					if (sites.some((s) => s.path === f.path && s.line === i + 1)) continue;
					const code = raw.trim();
					sites.push({
						path: f.path,
						file: f.file,
						line: i + 1,
						code: code.length > 140 ? code.slice(0, 139) + '…' : code,
						...(fn ? { fn_name: fn } : {}),
						cpu_ms: 0,
						alloc_bytes: 0,
						gc_ms: 0,
						calls: sync.get(x),
						in_loop: false
					});
				}
			}
		}
	}
	if (!sites.length) return undefined;
	const rule = RULES.find((r) => r.kind === 'sync-io')!;
	const said = [...new Set(sites.flatMap((s) => names.filter((n) => calls_name(s.code, [n]))))];
	return {
		kind: 'sync-io',
		title: rule.title(sites.length, sites),
		fix: rule.fix,
		sites,
		cost_ms: 0,
		alloc_bytes: 0,
		save_ms: 0,
		evidence: `${said.map((n) => `${n} ×${sync.get(n)}`).join(', ')} per render (V8's call counts): too quick for the CPU sampler here, under a millisecond, but each call stops every other request on this server until the disk answers.`
	};
}
const BLOCK_WORDS: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return']);
/** the *Sync calls V8's coverage counts under their own names (in Node's `node:` modules) */
const COUNTED_SYNC: ReadonlySet<string> = new Set([...SYNC_IO, 'appendFileSync', 'mkdirSync', 'openSync', 'readSync', 'execFileSync', 'pbkdf2Sync', 'scryptSync']);

export function find_patterns(input: PatternInput): Pattern[] {
	const fns = new Map<string, FrameStat>();
	for (const f of input.functions) fns.set(f.key, f);
	/** the function a memory-only line belongs to: its `at` line is where that function starts */
	const starts = new Map<string, FrameStat>();
	for (const f of input.functions) if (f.path && f.line > 0) starts.set(f.path + '\0' + f.line, f);
	/** a function by the `file:line` its callers' stack frames name it with */
	const by_loc = new Map<string, FrameStat>();
	for (const f of input.functions)
		if (f.url && f.line > 0 && !by_loc.has(f.url + ':' + f.line))
			by_loc.set(f.url + ':' + f.line, f);
	/** per file, the start lines of its functions, highest first */
	const starts_in = new Map<string, number[]>();
	for (const f of input.functions) {
		if (!f.path || f.line <= 0) continue;
		const list = starts_in.get(f.path);
		if (list) list.push(f.line);
		else starts_in.set(f.path, [f.line]);
	}
	for (const list of starts_in.values()) list.sort((a, b) => b - a);
	/** the start of the nearest function above the line whose body reaches it */
	const enclosing = (l: LedgerLine): number | undefined => {
		if (!input.source) return undefined;
		for (const s of starts_in.get(l.path) ?? []) {
			if (s >= l.line) continue;
			const body = function_body(input.source, l.path, s);
			if (body && body.start + body.lines.length - 1 >= l.line) return s;
		}
		return undefined;
	};
	const via_memo = new Map<string, CallSite[]>();
	/** a site's caller lines, when the site sits in a THIN WRAPPER: the costly line is the function's
	 *  own first line (a one-line arrow), or the function's own time is a small part of the cost */
	const via_of = (f: FrameStat | undefined, l: LedgerLine, local_loop: boolean): CallSite[] => {
		if (!f || !input.source || (f.category !== 'app' && f.category !== 'component')) return [];
		const cost = l.cpu_ms + (l.lib_ms ?? 0);
		// a thin wrapper always shows its callers; any other line only when it has no loop of its
		// own, to learn whether a caller loops over it (`replaceTagName` called once per tag)
		const thin = l.line === f.line || f.self_ms < 0.2 * cost;
		if (!thin && local_loop) return [];
		let v = via_memo.get(f.key);
		if (!v) via_memo.set(f.key, (v = call_sites_of(f, by_loc, input.source)));
		return v;
	};

	/** kind → its sites; a library call groups per library function (one renderer called per item
	 *  is one problem, a timer in another loop is another) */
	const found = new Map<string, { rule: Rule; sites: PatternSite[] }>();
	/** sites a RegExp's first use made at its build's line (the build's own line adds to them) */
	const moved = new Set<PatternSite>();
	for (const l of input.ledger) {
		if (!l.code) continue;
		const f = (l.fn ? fns.get(l.fn) : undefined) ?? starts.get(l.path + '\0' + l.line);
		const svelte = l.path.endsWith('.svelte');
		// a COMPILED component's line (a build without sourcemaps: the module map says the chunk line
		// is a .svelte module's, inside a function): its instance script, which runs on every render —
		// a fixed table built there is rebuilt every request, whatever the call counts say
		// (the render function itself: its first line takes the renderer — `function Card($$renderer,
		// $$props)`, `$$renderer.component(($$renderer) => {` — not a `<script module>` helper beside it,
		// which runs once)
		const compiled_component =
			!svelte &&
			!!l.module?.endsWith('.svelte') &&
			!!f &&
			f.line > 0 &&
			!!input.source?.(l.path, f.line, f.line)?.lines[0]?.includes('$$renderer');
		// the context starts at the function the line lives in; for a callback DEFINED on this line
		// (`BRANDS.find((b) => …)`, the costly frame) that is the function around it
		const own = f && f.line > 0 && f.line <= l.line && l.line - f.line < 400 ? f.line : l.line;
		const start = f && own === l.line && f.name.startsWith('(') ? (enclosing(l) ?? own) : own;
		const body = input.source?.(l.path, svelte ? 1 : start, l.line)?.lines ?? [l.code];
		let from = loop_from(body, svelte);
		const calls = f?.calls;
		const via = via_of(f, l, from >= 0);
		// no loop here, but a caller runs this function from one: the whole line runs per item
		if (from < 0 && via.some((v) => v.in_loop)) from = 0;
		const loop = from >= 0;
		const ctx: Ctx = {
			loop,
			from,
			// runs many times: in a loop here, counted more than once, or called from a loop above
			repeated: loop || (calls ?? 0) >= 2 || via.some((v) => v.in_loop) || compiled_component,
			svelte,
			module_scope: svelte && in_module_script(body),
			// the line's whole CPU: its own ticks plus the library time it caused
			cpu_ms: l.cpu_ms + (l.lib_ms ?? 0),
			alloc_bytes: l.alloc_bytes,
			lib_ms: l.lib_ms ?? 0,
			pkg_ms: (l.libs ?? []).filter((x) => x.pkg !== 'Node').reduce((s, x) => s + x.ms, 0),
			lib_names: (l.libs ?? []).map((x) => x.name),
			regex_ms: (l.libs ?? [])
				.filter((x) => x.name.startsWith(REGEXP_FRAME))
				.reduce((s, x) => s + x.ms, 0),
			regex_backtracks: (l.libs ?? []).some(
				(x) => x.name.startsWith(REGEXP_FRAME) && backtracks(x.name.slice(REGEXP_FRAME.length))
			),
			literal_backtracks: regex_literals(l.code).some(backtracks),
			// one call's share of one render (V8 counts calls in ONE render; the time is every render's)
			per_call_ms: calls
				? (l.cpu_ms + (l.lib_ms ?? 0)) / Math.max(1, input.renders ?? 1) / calls
				: undefined,
			per_call_bytes: calls ? l.alloc_bytes / Math.max(1, input.renders ?? 1) / calls : undefined,
			alloc_per_render: l.alloc_bytes / Math.max(1, input.renders ?? 1),
			intl_locals: intl_locals(body),
			text_locals: text_locals(body),
			regexp_locals: regexp_locals(body, svelte ? 1 : start),
			after: input.source?.(l.path, l.line + 1, l.line + 3)?.lines ?? []
		};
		const t = tokens(l.code);
		let matched = false;
		for (const rule of RULES) {
			if (!rule.match(t, ctx)) continue;
			// a sort's time is its comparator's: when the comparator calls a function with a shape of
			// its own (a date parsed per compare), that is the problem to name, not the sort
			if (
				rule.kind === 'sort-per-call' &&
				input.source &&
				look_inside(input.source, l, t, body, svelte, ctx)
			)
				break;
			const group =
				rule.kind === 'library-per-item' ? rule.kind + '\0' + (ctx.lib_names[0] ?? '') : rule.kind;
			let e = found.get(group);
			if (!e) found.set(group, (e = { rule, sites: [] }));
			// (a line already named from inside another line's loop or callee is not listed twice)
			matched = true;
			// A REGEXP'S FIRST USE (`re.test(s)`) charged with its build: the site is the build's line,
			// and the two lines' cost one site's
			const built = rule.kind === 'regexp-per-call' && !constructs(t, REGEXP) ? used_local_regexp(t, ctx.regexp_locals) : undefined;
			const line = built?.line ?? l.line;
			const same = e.sites.find((s) => s.path === l.path && s.line === line);
			if (same) {
				// (the use's line came first and made the site: the build's own line adds to it too)
				if (built || moved.has(same)) {
					same.cpu_ms += l.cpu_ms;
					same.alloc_bytes += l.alloc_bytes;
					same.gc_ms += l.gc_ms;
				}
				break;
			}
			e.sites.push({
				path: l.path,
				file: l.file,
				line,
				code: built?.code ?? l.code,
				...(f ? { fn: f.key, fn_name: f.name } : l.fn ? { fn: l.fn } : {}),
				cpu_ms: l.cpu_ms,
				alloc_bytes: l.alloc_bytes,
				gc_ms: l.gc_ms,
				...(calls ? { calls } : {}),
				in_loop: loop,
				// (a RegExp's use: its library time is the pattern RUNNING, which building it once keeps)
				...(l.lib_ms && !built
					? {
							lib_ms: l.lib_ms,
							libs: (l.libs ?? []).map((x) => (x.pkg ? `${x.name} (${x.pkg})` : x.name))
						}
					: {}),
				...(via.length ? { via } : {}),
				...ctx_field(input.source, l.path, line)
			});
			if (built) moved.add(e.sites[e.sites.length - 1]);
			// one line, one pattern: the first rule (most specific) wins
			matched = true;
			break;
		}
		// INLINED CODE: optimised code charges an inlined function's time to the line that calls it,
		// and a loop body's to the loop's header — the costly line shows no shape of its own. Read
		// one level in: the called app function's body, or the loop's block, with this line's cost
		// and context, and name the line inside that has the shape (this line becomes "called from").
		if (!matched && input.source && l.cpu_ms + (l.lib_ms ?? 0) >= 1) {
			const inner = look_inside(input.source, l, t, body, svelte, ctx);
			if (inner) {
				let e = found.get(inner.rule.kind);
				if (!e) found.set(inner.rule.kind, (e = { rule: inner.rule, sites: [] }));
				if (!e.sites.some((s) => s.path === inner.path && s.line === inner.line))
					e.sites.push({
						path: inner.path,
						file: short_file(inner.path),
						line: inner.line,
						code: inner.code,
						...(f ? { fn: f.key, fn_name: f.name } : l.fn ? { fn: l.fn } : {}),
						cpu_ms: l.cpu_ms,
						alloc_bytes: l.alloc_bytes,
						gc_ms: l.gc_ms,
						in_loop: true,
						...(inner.via
							? {
									via: [
										{
											path: l.path,
											file: l.file,
											line: l.line,
											code: l.code,
											in_loop: loop,
											...(f ? { fn: f.key } : {})
										}
									]
								}
							: {}),
						...ctx_field(input.source, inner.path, inner.line)
					});
			}
		}
	}

	const out: Pattern[] = [];
	for (const { rule, sites } of found.values()) {
		const cost = sites.reduce((s, x) => s + x.cpu_ms + x.gc_ms + (x.lib_ms ?? 0), 0);
		const alloc = sites.reduce((s, x) => s + x.alloc_bytes, 0);
		out.push({
			kind: rule.kind,
			title: rule.title(sites.length, sites),
			fix: rule.fix,
			...(rule.example ? { example: rule.example } : {}),
			sites,
			cost_ms: r2(cost),
			alloc_bytes: Math.round(alloc),
			save_ms: r2(cost * rule.saves),
			evidence: evidence_of(sites, input.renders)
		});
	}
	// a pattern that would give back under a millisecond is true but not worth a card: on a page
	// that is fine, the list stays empty instead of filling with crumbs
	const timed = out
		.filter((p) => p.save_ms >= MIN_SAVE_MS)
		.sort((a, b) => b.save_ms - a.save_ms || b.alloc_bytes - a.alloc_bytes);
	const kept = kept_pattern(input);
	if (!kept) return timed;
	// a leak this size takes the server down within a few dozen requests: first, not last
	return (kept.kept_bytes ?? 0) >= KEPT_SEVERE && kept.growth !== 'levels-off'
		? [kept, ...timed]
		: [...timed, kept];
}

/** "; at that rate its heap (4.0 GB, 1.2 GB used) is full after about 43 more requests" */
function countdown(kept: number, heap: PatternInput['heap']): string {
	const gb = (b: number) =>
		b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
	// profiled off the platform with its memory size set: already past what the function may use
	if (heap?.function && kept > 0 && heap.used_bytes >= heap.limit_bytes)
		return `; this process already uses ${gb(heap.used_bytes)}, more than the function's ${gb(heap.limit_bytes)}: on the platform this instance would already have been killed`;
	if (!heap || !(heap.limit_bytes > heap.used_bytes) || kept <= 0) return '';
	const left = Math.floor((heap.limit_bytes - heap.used_bytes) / kept);
	// a serverless function dies at its memory size, long before the heap's own limit: the platform
	// kills the instance, the request on it fails, and the next one pays a cold start
	if (heap.function)
		return `; at that rate the function's memory (${gb(heap.limit_bytes)}, ${gb(heap.used_bytes)} in use now) runs out after about ${left.toLocaleString('en-US')} more requests on one instance, and the platform then kills it: that request fails and the next one pays a cold start`;
	return `; at that rate its heap (${gb(heap.limit_bytes)}, ${gb(heap.used_bytes)} used) is full after about ${left.toLocaleString('en-US')} more requests`;
}

/** kept per render at or past this is an outage waiting (8 MB × a few hundred requests = the heap) */
const KEPT_SEVERE = 8 * 1024 * 1024;

/** a line keeping less than this alive after a render is noise (a closure, a small memo) */
const KEPT_LINE_MIN = 128 * 1024;
/** and the pattern needs this much in all */
const KEPT_MIN = 256 * 1024;
/** a place listed holds at least this share of what all of them keep (the biggest always is) */
const KEPT_SHARE_MIN = 0.02;

/**
 * MEMORY KEPT AFTER EVERY RENDER: the retention pass renders once more AFTER the warm runs, then
 * collects garbage, and the heap sample keeps only what that render allocated and is STILL alive.
 * A cache would have filled on the first renders, so what one more warm render leaves behind is
 * growth: memory the server adds with every request. Its own card (not one rule among the line
 * rules): a line can burn CPU and leak at once. Measured per line; no time saving is claimed.
 */
function kept_pattern(input: PatternInput): Pattern | undefined {
	const sites: PatternSite[] = [];
	/** a site's kept memory made INSIDE a library: the library's own function that made it (the
	 *  first maker on the line that is neither the app's function nor the library call it makes) */
	const lib_maker = new Map<PatternSite, string>();
	for (const l of input.ledger) {
		if (l.retained_bytes < KEPT_LINE_MIN || !l.code) continue;
		const own = l.fn?.split(' ')[0];
		const called = new Set((l.libs ?? []).map((x) => x.name));
		const maker = l.mem_via
			? l.who.find((w) => w !== own && !called.has(w) && !w.startsWith('('))
			: undefined;
		const site: PatternSite = {
			path: l.path,
			file: l.file,
			line: l.line,
			code: l.code,
			...(l.fn ? { fn: l.fn } : {}),
			cpu_ms: 0,
			alloc_bytes: 0,
			gc_ms: 0,
			in_loop: false,
			kept_bytes: l.retained_bytes,
			...(l.mem_via ? { mem_via: l.mem_via } : {}),
			...(l.grows !== undefined ? { grows: l.grows } : {}),
			...ctx_field(input.source, l.path, l.line)
		};
		sites.push(site);
		if (maker) lib_maker.set(site, maker);
	}
	const kept = sites.reduce((s, x) => s + (x.kept_bytes ?? 0), 0);
	if (kept < KEPT_MIN) return undefined;
	sites.sort((a, b) => (b.kept_bytes ?? 0) - (a.kept_bytes ?? 0));
	// PASSENGERS: a line holding a sliver of the total (a page.data tree made each render) is most
	// likely kept BY the big one, not a leak of its own: whatever holds the render's data holds it
	// too. Listed as a place it sends the reader to fix what is not broken, so it is left out and
	// counted (the total above still includes it)
	const floor = kept * KEPT_SHARE_MIN;
	let cut = sites.findIndex((s, i) => i > 0 && (s.kept_bytes ?? 0) < floor);
	if (cut === -1) cut = sites.length;
	const minor = sites.splice(cut);
	const minor_bytes = minor.reduce((s, x) => s + (x.kept_bytes ?? 0), 0);
	const minor_note = minor.length
		? ` ${minor.length} smaller line${minor.length === 1 ? '' : 's'} hold ${fmt_mb(minor_bytes)} more, each under ${Math.round(KEPT_SHARE_MIN * 100)}% of it: most likely data the render made that is kept along with the rest, so fixing the lines here frees it too.`
		: '';
	const g = input.growth;
	const mb = (b: number) => (b / MB).toFixed(0);
	// the growth check, when it ran: a measured climb over several renders, or a plateau
	const confirm = !g
		? ''
		: g.levels_off
			? ` Over ${g.renders} more renders it levelled off (${mb(g.start_bytes)} → ${mb(g.end_bytes)} MB): most likely a cache with a size limit filling up, not a leak.`
			: ` Confirmed over ${g.renders} more renders, a full collection after each: the heap went ${mb(g.start_bytes)} → ${mb(g.end_bytes)} MB, about ${fmt_mb(g.per_render_bytes)} a render, and kept climbing.`;
	// a confirmed rate counts down better than one render's sample
	const rate = g && !g.levels_off && g.per_render_bytes > 0 ? g.per_render_bytes : kept;
	const room =
		input.heap && input.heap.limit_bytes > input.heap.used_bytes && !g?.levels_off
			? input.heap
			: undefined;
	// WHOSE MEMORY: when most of it was made inside a library your line calls, the library is what
	// keeps it; a Map in your code is the wrong place to look, and the fixes are the library's
	const top = sites[0];
	const lib = top?.mem_via && (top.kept_bytes ?? 0) >= kept * 0.6 ? top.mem_via : undefined;
	const maker = lib ? lib_maker.get(top) : undefined;
	const where = g?.levels_off
		? 'Memory grows, then levels off'
		: 'Memory stays alive after every render';
	return {
		kind: 'kept-per-render',
		title: lib
			? `${where}, inside ${lib}${places(sites.length)}`
			: `${where}${places(sites.length)}`,
		fix: lib
			? `Your line only calls ${lib}; what stays alive was made inside it${maker ? ` (${maker})` : ''} and is held by the library, not by your code. The usual causes, most likely first: a new instance or engine made on every call where the library expects one made once and reused; a registry or cache inside it that every call adds to, which an option or a documented cleanup call (destroy, dispose, reset) empties; a bug fixed in a newer version (check its changelog for "memory" or "leak"). If none of those fixes it, give its work a home that is thrown away: a worker thread you replace every few hundred renders.`
			: 'Something outside the render still points at what these lines make: a module-level Map or array that only grows, a cache with no size limit or a key that never hits, a listener or timer holding a closure, or a global regex keeping its last input. Bound the cache (a max size, least-recently-used out), key it so it hits, or keep the value inside the request. One check before you fix: a cache or log that HAS a size limit and is still filling shows here too, and stops growing once full; send the page a few hundred requests and see whether memory levels off.',
		example: lib
			? {
					before:
						'export function render(html) {\n\tconst engine = createEngine(); // a new one, and its registry, every call\n\treturn engine.render(html);\n}',
					after:
						'const engine = createEngine(); // made once, reused\nexport function render(html) {\n\treturn engine.render(html);\n}'
				}
			: {
					before:
						'const seen = new Map(); // module scope\nexport function load({ url }) { seen.set(url.href, bigResult); … }',
					after:
						'const seen = new Map();\nconst MAX = 500;\nfunction remember(k, v) {\n\tif (seen.size >= MAX) seen.delete(seen.keys().next().value);\n\tseen.set(k, v);\n}'
				},
		sites,
		cost_ms: 0,
		alloc_bytes: 0,
		save_ms: 0,
		evidence: `${fmt_mb(kept)} is still alive after one more warm render and a full collection${g?.levels_off ? '' : ': the server grows by about that much with every request'}${countdown(rate, room ?? (input.heap?.function && !g?.levels_off ? input.heap : undefined))}.${confirm}${minor_note}`,
		kept_bytes: kept,
		...(room ? { requests_left: Math.floor((room.limit_bytes - room.used_bytes) / rate) } : {}),
		...(g ? { growth: g.levels_off ? ('levels-off' as const) : ('grows' as const) } : {})
	};
}

const fmt_mb = (b: number) =>
	b >= MB
		? `${(b / MB).toFixed(b >= 100 * MB ? 0 : 1)} MB`
		: b >= 1024
			? `${Math.round(b / 1024)} KB`
			: `${Math.round(b)} bytes`;

/** "183 ms of CPU, 1.8 GB made, 53 ms cleanup; formatPrice ran 480 times" */
/** UNITS: the CPU, bytes and GC add up every profiled render (`renders`); the run count comes from
 *  V8's coverage of ONE render. The sentence says both, so neither is read against the other. */
function evidence_of(sites: readonly PatternSite[], renders = 1): string {
	const cpu = sites.reduce((s, x) => s + x.cpu_ms, 0);
	const alloc = sites.reduce((s, x) => s + x.alloc_bytes, 0);
	const gc = sites.reduce((s, x) => s + x.gc_ms, 0);
	const parts: string[] = [];
	if (cpu >= 0.05) parts.push(`${r2(cpu)} ms of CPU`);
	if (alloc > 0) parts.push(`${fmt_mb(alloc)} made`);
	if (gc >= 0.05) parts.push(`${r2(gc)} ms of cleanup`);
	const lib = sites.reduce((s, x) => s + (x.lib_ms ?? 0), 0);
	if (lib >= 0.05) {
		const pkgs = [
			...new Set(
				sites
					.flatMap((x) => x.libs ?? [])
					.map((n) => (n.includes(' (') ? n.slice(n.indexOf(' (') + 2, -1) : n))
			)
		];
		parts.push(`${r2(lib)} ms inside ${pkgs.slice(0, 2).join(', ') || 'libraries'}`);
	}
	// the run count of the costliest site that has one: the number that explains the cost
	const counted = sites
		.filter((s) => s.calls && s.fn_name)
		.sort(
			(a, b) => b.cpu_ms + b.gc_ms + (b.lib_ms ?? 0) - (a.cpu_ms + a.gc_ms + (a.lib_ms ?? 0))
		)[0];
	let s = parts.join(', ');
	if (s && renders > 1) s += ` over ${renders} renders`;
	if (counted)
		s += `${s ? '; ' : ''}${counted.fn_name} ran ${counted.calls} times${renders > 1 ? ' in one render' : ''}`;
	return s;
}

// ── waiting: calls from one line that wait one after another ───────────────────

/** one finished wait, from the network log or the I/O log */
export interface WaitCall {
	start: number;
	/** the whole wait: headers + body for a fetch, init → destroy for an I/O resource */
	ms: number;
	/** what it waited on, as a group label (`GET api.shop.test/stock/:id`, `file read`) */
	target: string;
	/** the app line that made the call */
	at?: { path: string; line: number };
	/** the line that called THAT function, when the call sits in a helper (`fetchStock`) */
	outer?: { path: string; line: number };
	/** the page it served (calls of different requests never chain) */
	scope?: string | null;
	/** the exact request, for a read (`GET https://api/session?x=1`): two with the same one in a render
	 *  asked for the same answer. Absent for writes, whose repeats can be on purpose. */
	exact?: string;
	/** the decoded body size, when read */
	bytes?: number;
	/** the request carried a cookie or an authorization header (its answer may be per user) */
	personal?: boolean;
	/** the answer's own `Cache-Control`, as the service sent it */
	cache?: string;
}

export type CacheRules = {
	max_age?: number;
	no_store?: boolean;
	no_cache?: boolean;
	private?: boolean;
};

/** What a service's `Cache-Control` allows: how long a copy may be kept (s-maxage over max-age, for
 *  a shared cache), whether it must not be stored, must be checked with the service before every
 *  reuse (`no-cache`, or a max-age of 0), or is one user's. Split by hand, no regex. */
export function cache_rules(header: string | undefined): CacheRules | undefined {
	if (!header) return undefined;
	const out: CacheRules = {};
	let shared: number | undefined;
	for (const part of header.split(',')) {
		const d = part.trim().toLowerCase();
		const eq = d.indexOf('=');
		const name = eq === -1 ? d : d.slice(0, eq).trim();
		const value = eq === -1 ? '' : d.slice(eq + 1).trim();
		if (name === 'no-store') out.no_store = true;
		else if (name === 'no-cache') out.no_cache = true;
		else if (name === 'private') out.private = true;
		else if (name === 'max-age' && value && Number.isFinite(Number(value)))
			out.max_age = Number(value);
		else if (name === 's-maxage' && value && Number.isFinite(Number(value))) shared = Number(value);
	}
	if (shared !== undefined) out.max_age = shared;
	// kept for no time: every reuse must be checked first
	if (out.max_age === 0) {
		out.no_cache = true;
		delete out.max_age;
	}
	return Object.keys(out).length ? out : undefined;
}

export interface WaitInput {
	calls: readonly WaitCall[];
	source?: SourceReader;
}

/** calls closer than this (ms) after the previous one ended still count as "right after it" */
const CHAIN_GAP_MS = 10;
/** a chain needs this many calls, and this much waiting, to be worth a card */
const CHAIN_MIN = 3;
const CHAIN_MIN_MS = 20;

/**
 * THE WAITS IN A ROW: calls made from ONE line whose waits did not overlap — each started after
 * the one before it ended — so the line waited for them one by one (`for (…) await fetch(…)`).
 * Measured, not guessed: the sum of the waits is what the line cost in wall time, the longest
 * one is about what it would cost if they ran together, and the difference is the saving.
 */
export function find_wait_patterns(input: WaitInput): Pattern[] {
	const groups = new Map<string, WaitCall[]>();
	for (const c of input.calls) {
		if (!c.at || c.at.line <= 0 || c.ms < 0) continue;
		const k = c.at.path + '\0' + c.at.line + '\0' + (c.scope ?? '');
		const g = groups.get(k);
		if (g) g.push(c);
		else groups.set(k, [c]);
	}
	const sites: PatternSite[] = [];
	const longest_of = new Map<PatternSite, number>();
	/** each site's chain, the calls in order (their start on the recording's clock): what the
	 *  critical-path check (`wait_save_on_path`) starts together */
	const chain_of = new Map<PatternSite, { start: number; ms: number }[]>();
	// A LINK THE CODE NEEDS: the later call reads what the earlier one produced (its line reads a
	// name the earlier line wrote, through the lines between; or a loop turn feeds the next). Such
	// calls cannot run together — the order is the program, not a missed Promise.all.
	const needs_memo = new Map<string, boolean>();
	const needs = (a: WaitCall, b: WaitCall): boolean => {
		const pa = a.outer ?? a.at;
		const pb = b.outer ?? b.at;
		if (!input.source || !pa || !pb || pa.path !== pb.path) return false;
		const k = pa.path + '\0' + pa.line + '\0' + pb.line;
		let v = needs_memo.get(k);
		if (v === undefined)
			needs_memo.set(
				k,
				(v =
					(pa.line === pb.line && !loops_here(input.source, pa.path, pa.line)) ||
					needs_previous(input.source, pa.path, pa.line, pb.line))
			);
		return v;
	};
	for (const g of groups.values()) {
		if (g.length < 2) continue;
		g.sort((a, b) => a.start - b.start);
		// EVERY run of calls each starting after the previous ended (with a small gap): one helper line
		// can serve two separate chains (`user → cart → promos`, later `session → locale → again`),
		// and keeping only the longest hid the other
		const runs: WaitCall[][] = [];
		// a call that started together with another from this line is one of a batch already run in
		// parallel (a Promise.all): never a link in a chain. Taking the batch's first call as the next
		// link made the batch's other calls look like work running beside the chain.
		// (started with another from the SAME calling line: a layout's call through the same helper,
		// starting alongside, is not this chain's batch)
		const batched = (c: WaitCall) =>
			g.some(
				(o) =>
					o !== c &&
					Math.abs(o.start - c.start) < 1 &&
					(o.outer?.line ?? o.at?.line) === (c.outer?.line ?? c.at?.line) &&
					(o.outer?.path ?? o.at?.path) === (c.outer?.path ?? c.at?.path)
			);
		let run: WaitCall[] = batched(g[0]) ? [] : [g[0]];
		for (let i = 1; i < g.length; i++) {
			if (batched(g[i])) {
				runs.push(run);
				run = [];
				continue;
			}
			const prev = run[run.length - 1];
			const end = prev ? prev.start + prev.ms : -Infinity;
			if (prev && g[i].start >= end - 0.5 && g[i].start - end <= CHAIN_GAP_MS && !needs(prev, g[i]))
				run.push(g[i]);
			else {
				runs.push(run);
				run = [g[i]];
			}
		}
		runs.push(run);
		for (const best of runs) {
			if (best.length < 2) continue;
			const wait = best.reduce((s, c) => s + c.ms, 0);
			// the lines that called the helper, when the call sits in one: two awaits of it written out
			// on two lines (`await get('a'); await get('b')`) are a chain at two calls already; a loop
			// needs three to be sure
			const outers = new Map<string, { path: string; line: number }>();
			for (const c of best) if (c.outer) outers.set(c.outer.path + ':' + c.outer.line, c.outer);
			const min = outers.size >= 2 ? 2 : CHAIN_MIN;
			if (best.length < min || wait < CHAIN_MIN_MS) continue;
			const at = best[0].at!;
			const code = input.source?.(at.path, at.line, at.line)?.lines[0]?.trim() ?? '';
			// is the call inside a loop? read up from it (the function's start is unknown here; a loop
			// that closed above the call is popped by the block tracking)
			const loop_at = (p: { path: string; line: number }) => {
				const above = input.source?.(p.path, Math.max(1, p.line - 40), p.line)?.lines;
				return above ? loop_from(above, p.path.endsWith('.svelte')) >= 0 : false;
			};
			const via: CallSite[] = [...outers.values()].slice(0, VIA_MAX).map((o) => {
				const oc = input.source?.(o.path, o.line, o.line)?.lines[0]?.trim() ?? '';
				return {
					path: o.path,
					file: short_file(o.path),
					line: o.line,
					code: oc.length > 140 ? oc.slice(0, 139) + '…' : oc,
					in_loop: loop_at(o)
				};
			});
			const longest = Math.max(...best.map((c) => c.ms));
			const targets = [...new Set(best.map((c) => c.target))];
			const in_loop = loop_at(at) || via.some((v) => v.in_loop);
			// THE CHANGE, WRITTEN: hand-written awaits of one file (not a loop), as one Promise.all
			let rewrite: { before: string; after: string } | undefined;
			const own = [...outers.values()];
			if (!in_loop && own.length >= 2 && own.every((o) => o.path === own[0].path) && input.source) {
				const ls = own.map((o) => o.line);
				const got = input.source(own[0].path, Math.min(...ls), Math.max(...ls));
				if (got) rewrite = promise_all_rewrite(got.lines, got.start, ls);
			}
			sites.push({
				path: at.path,
				file: short_file(at.path),
				line: at.line,
				code: code.length > 140 ? code.slice(0, 139) + '…' : code,
				cpu_ms: 0,
				alloc_bytes: 0,
				gc_ms: 0,
				calls: best.length,
				in_loop,
				wait_ms: r2(wait),
				target: targets.length === 1 ? targets[0] : `${targets[0]} and ${targets.length - 1} more`,
				...(via.length ? { via } : {}),
				...(rewrite
					? {
							rewrite: {
								...rewrite,
								file: short_file(own[0].path),
								line: Math.min(...own.map((o) => o.line))
							}
						}
					: {}),
				...ctx_field(input.source, at.path, at.line)
			});
			longest_of.set(sites[sites.length - 1], longest);
			chain_of.set(
				sites[sites.length - 1],
				best.map((c) => ({ start: c.start, ms: c.ms }))
			);
		}
	}
	const out: Pattern[] = [];
	const repeats = find_repeats(input);
	const straggler = find_stragglers(input);
	const others = [repeats, straggler].filter((p): p is Pattern => !!p);
	if (!sites.length) return others;
	sites.sort((a, b) => (b.wait_ms ?? 0) - (a.wait_ms ?? 0));
	const cost = sites.reduce((s, x) => s + (x.wait_ms ?? 0), 0);
	// run together, a chain waits about as long as its longest call
	const save = sites.reduce((s, x) => s + (x.wait_ms ?? 0) - (longest_of.get(x) ?? 0), 0);
	const top = sites[0];
	out.push({
		kind: 'waits-in-a-row',
		title: `Calls wait one after another instead of together${sites.length > 1 ? ` (${sites.length} places)` : ''}`,
		fix: 'Each call starts only after the one before it finished, so the waits add up. Start them all first, then await them together (Promise.all), or ask the API for all of them in one request. If the upstream cannot take many at once, run a few at a time.',
		example: {
			before: 'for (const id of ids) items.push(await getItem(id));',
			after: 'const items = await Promise.all(ids.map((id) => getItem(id)));'
		},
		sites,
		cost_ms: r2(cost),
		alloc_bytes: 0,
		save_ms: r2(save),
		evidence: `${top.calls} calls to ${top.target}, ${r2(top.wait_ms ?? 0)} ms of waiting in a row`,
		wait: true,
		chains: sites.map((s) => chain_of.get(s) ?? [])
	});
	out.push(...others);
	return out;
}

/** a batch's slowest call holds it when it takes this many times the next slowest, and this much longer */
const STRAGGLER_RATIO = 3;
const STRAGGLER_MIN_MS = 20;

/**
 * ONE SLOW CALL HOLDS A BATCH: calls started together from one line (a `Promise.all`), where one
 * takes several times as long as the rest. The batch — and everything after it — waits for that
 * one while the others are long done. Up to the gap between it and the next slowest comes off the
 * render if it stops holding the batch: started earlier, its result deferred to what needs it, or
 * given a timeout with a fallback.
 */
function find_stragglers(input: WaitInput): Pattern | undefined {
	const by_line = new Map<string, WaitCall[]>();
	for (const c of input.calls) {
		const p = c.outer ?? c.at;
		if (!p || c.ms < 0) continue;
		const k = p.path + '\0' + p.line + '\0' + (c.scope ?? '');
		(by_line.get(k) ?? by_line.set(k, []).get(k)!).push(c);
	}
	const sites: PatternSite[] = [];
	let save = 0;
	for (const list of by_line.values()) {
		list.sort((a, b) => a.start - b.start);
		// batches: calls started within a millisecond of each other
		for (let i = 0; i < list.length;) {
			let j = i + 1;
			while (j < list.length && list[j].start - list[i].start < 1) j++;
			const batch = list.slice(i, j);
			i = j;
			if (batch.length < 2) continue;
			const by_ms = [...batch].sort((a, b) => b.ms - a.ms);
			const [slow, next] = by_ms;
			if (slow.ms < next.ms * STRAGGLER_RATIO || slow.ms - next.ms < STRAGGLER_MIN_MS) continue;
			const p = slow.outer ?? slow.at!;
			const code = input.source?.(p.path, p.line, p.line)?.lines[0]?.trim() ?? '';
			// a batch AWAITED together (a Promise.all on the line or just above it): calls started
			// together and left unawaited on purpose (a streamed value) hold nothing
			const above = input.source?.(p.path, Math.max(1, p.line - 4), p.line)?.lines.join('\n');
			if (above !== undefined && !above.includes('Promise.all')) continue;
			sites.push({
				path: p.path,
				file: short_file(p.path),
				line: p.line,
				code: code.length > 140 ? code.slice(0, 139) + '…' : code,
				cpu_ms: 0,
				alloc_bytes: 0,
				gc_ms: 0,
				calls: batch.length,
				in_loop: false,
				wait_ms: r2(slow.ms),
				target: slow.target,
				...ctx_field(input.source, p.path, p.line)
			});
			save += slow.ms - next.ms;
			straggler_next.set(sites[sites.length - 1], next.ms);
		}
	}
	if (!sites.length) return undefined;
	sites.sort((a, b) => (b.wait_ms ?? 0) - (a.wait_ms ?? 0));
	const top = sites[0];
	return {
		kind: 'batch-straggler',
		title: `One slow call holds a batch of calls${places(sites.length)}`,
		fix: `The calls start together, but one takes far longer than the rest, so the batch — and everything after it — waits for that one while the others are long done. Start it earlier (before other work), hand its promise to the part that needs it instead of awaiting it with the rest, or give it a timeout with a fallback.`,
		example: {
			before:
				'const [nav, user, recs] = await Promise.all([getNav(), getUser(), getRecs()]); // recs: 90 ms',
			after:
				'const recs = getRecs(); // started, not awaited here\nconst [nav, user] = await Promise.all([getNav(), getUser()]);'
		},
		sites,
		cost_ms: r2(sites.reduce((s, x) => s + (x.wait_ms ?? 0), 0)),
		alloc_bytes: 0,
		save_ms: r2(save),
		wait: true,
		evidence: `${top.target} takes ${r2(top.wait_ms ?? 0)} ms; the other ${(top.calls ?? 2) - 1} call${(top.calls ?? 2) - 1 === 1 ? '' : 's'} started with it end by ${r2(straggler_next.get(top) ?? 0)} ms`
	};
}
const straggler_next = new WeakMap<PatternSite, number>();

/**
 * THE SAME REQUEST, AGAIN: one render made the exact same read (method + URL) more than once —
 * two parts of the page each fetching the session, a helper called twice. Every call after the
 * first asked for an answer the render already had (or was already waiting for); their waiting is
 * the saving. Each place that made one is listed.
 */
function find_repeats(input: WaitInput): Pattern | undefined {
	const groups = new Map<string, WaitCall[]>();
	for (const c of input.calls) {
		if (!c.exact || !c.at || c.ms < 0) continue;
		const k = c.exact + '\0' + (c.scope ?? '');
		const g = groups.get(k);
		if (g) g.push(c);
		else groups.set(k, [c]);
	}
	const sites: PatternSite[] = [];
	for (const g of groups.values()) {
		if (g.length < 2) continue;
		g.sort((a, b) => a.start - b.start);
		const extra = g.slice(1).reduce((s, c) => s + c.ms, 0);
		if (extra < 2) continue;
		// every distinct line that asked: the helper's callers when the fetch sits in a helper
		const asked = new Map<string, { path: string; line: number }>();
		for (const c of g) {
			const p = c.outer ?? c.at!;
			asked.set(p.path + ':' + p.line, p);
		}
		const at = g[0].at!;
		const code = input.source?.(at.path, at.line, at.line)?.lines[0]?.trim() ?? '';
		const via: CallSite[] = [...asked.values()].slice(0, VIA_MAX).map((o) => {
			const oc = input.source?.(o.path, o.line, o.line)?.lines[0]?.trim() ?? '';
			return {
				path: o.path,
				file: short_file(o.path),
				line: o.line,
				code: oc.length > 140 ? oc.slice(0, 139) + '…' : oc,
				in_loop: false
			};
		});
		sites.push({
			path: at.path,
			file: short_file(at.path),
			line: at.line,
			code: code.length > 140 ? code.slice(0, 139) + '…' : code,
			cpu_ms: 0,
			alloc_bytes: 0,
			gc_ms: 0,
			calls: g.length,
			in_loop: false,
			wait_ms: r2(extra),
			target: g[0].exact!,
			...(via.length > 1 || (via[0] && via[0].line !== at.line) ? { via } : {}),
			...ctx_field(input.source, at.path, at.line)
		});
	}
	if (!sites.length) return undefined;
	sites.sort((a, b) => (b.wait_ms ?? 0) - (a.wait_ms ?? 0));
	const save = sites.reduce((s, x) => s + (x.wait_ms ?? 0), 0);
	const top = sites[0];
	return {
		kind: 'repeat-request',
		title: `The same request is made more than once in one render${sites.length > 1 ? ` (${sites.length} requests)` : ''}`,
		fix: 'Each extra call asks for an answer the render already has. Fetch it once per request and share it: keep the promise in a request-scoped cache (event.locals, or a Map made per request), or load it once in the layout and read it from the parent data.',
		example: {
			before: 'const user = await getSession(); … const locale = (await getSession()).locale;',
			after:
				'const session = getSession(); // once, shared\nconst user = await session; … const { locale } = await session;'
		},
		sites,
		cost_ms: r2(save),
		alloc_bytes: 0,
		save_ms: r2(save),
		evidence: `${top.target} was requested ${top.calls} times; ${r2(top.wait_ms ?? 0)} ms went to the repeats`,
		wait: true
	};
}

/** `src/lib/x.ts` from a full path (the part from `src/`, else the last three segments) */
function short_file(path: string): string {
	const p = path.startsWith('file://') ? path.slice(7) : path;
	const src = p.lastIndexOf('/src/');
	if (src !== -1) return p.slice(src + 1);
	const parts = p.split('/');
	return parts.length > 3 ? parts.slice(-3).join('/') : p;
}

// ── what fixing them is worth ─────────────────────────────────────────────────

export interface FixImpact {
	/** estimated CPU a fix of every pattern gives back, ms */
	cpu_ms: number;
	/** estimated waiting it gives back, ms */
	wait_ms: number;
	/** the render it is measured against (median of the runs), ms */
	render_ms: number;
	/** the render after the fixes, about; never below a tenth of today's */
	after_ms: number;
	/** share of the render the fixes take off, 0..90 */
	pct: number;
}

/** "Fix these and the render goes from 754 ms to ~300 ms." Each costly line belongs to one pattern,
 *  so the savings add without counting a line twice; the sum is capped at 90 % of the render (an
 *  estimate never promises a free page). Undefined without a render to measure against.
 *
 *  UNITS: a CPU pattern's numbers add up the whole recording — `renders` renders in page mode —
 *  while a waiting pattern is measured on ONE render (the network log is scoped to one run). CPU
 *  savings are divided by `renders` so both are per render, like `render_ms`. */
export function fix_impact(
	patterns: readonly Pick<Pattern, 'save_ms' | 'wait'>[],
	render_ms: number,
	renders = 1,
	wait_ms?: number
): FixImpact | undefined {
	if (!patterns.length || !(render_ms > 0)) return undefined;
	const n = Math.max(1, renders);
	let cpu = 0;
	let wait = 0;
	for (const p of patterns) {
		if (p.wait) wait += p.save_ms;
		else cpu += p.save_ms / n;
	}
	// the wait fixes overlap (cache an answer, OR start its calls together: the same waiting either
	// way), so together they take off at most the waiting the render had
	if (wait_ms !== undefined && wait_ms >= 0) wait = Math.min(wait, wait_ms);
	const off = Math.min(cpu + wait, render_ms * 0.9);
	return {
		cpu_ms: r2(cpu),
		wait_ms: r2(wait),
		render_ms: r2(render_ms),
		after_ms: r2(render_ms - off),
		pct: Math.round((off / render_ms) * 100)
	};
}

// ── does the heap keep growing? ───────────────────────────────────────────────

export interface HeapGrowth {
	/** renders measured (each followed by a full collection) */
	renders: number;
	/** used heap after the first collection, and after the last render's */
	start_bytes: number;
	end_bytes: number;
	/** average growth per render */
	per_render_bytes: number;
	/** the second half of the renders grew far less than the first: a bounded cache filling up */
	levels_off: boolean;
	/** the used heap after each collection, MB */
	series_mb: number[];
	/** what each allocation line still held after all the renders (a live sample across them) */
	sites?: RetainedSite[];
	/** the same sampler read halfway (after `half_renders`): a leaking line grows from it in step */
	half_renders?: number;
	half_sites?: RetainedSite[];
}

/** A leak grows the same every render; a cache with a size limit grows, then stops. The second
 *  half's rate against the first half's tells them apart; under 64 KB a render is flat either way. */
/** A growth series (the settled heap before, then after each render) that is FLAT: under 32 KB a
 *  render (half of `heap_growth`'s line), and every settled reading after the first render within
 *  256 KB of the others — more renders could not make it grow, so the check may stop. */
export function is_flat(series: readonly number[]): boolean {
	const n = series.length - 1;
	if (n < 1) return false;
	if ((series[n] - series[0]) / n >= 32 * 1024) return false;
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 1; i <= n; i++) {
		lo = Math.min(lo, series[i]);
		hi = Math.max(hi, series[i]);
	}
	return hi - lo < 256 * 1024;
}

export function heap_growth(series: readonly number[]): HeapGrowth | undefined {
	const n = series.length - 1;
	if (n < 2) return undefined;
	const mid = Math.max(1, Math.floor(n / 2));
	const first = (series[mid] - series[0]) / mid;
	const second = (series[n] - series[mid]) / Math.max(1, n - mid);
	const per = (series[n] - series[0]) / n;
	return {
		renders: n,
		start_bytes: Math.round(series[0]),
		end_bytes: Math.round(series[n]),
		per_render_bytes: Math.round(per),
		levels_off: per < 64 * 1024 || (first > 0 && second < first * 0.25),
		series_mb: series.map((b) => r2(b / MB))
	};
}

// ── ogygia: islands that take the page's data whole ────────────────────────────

export interface WholeReader {
	/** the component, as the page names it */
	name: string;
	/** its file (for display and the row) */
	file: string;
	line: number;
	code: string;
	context?: { start: number; lines: string[] };
}

/**
 * THE SEED SHIPS WHOLE BECAUSE OF A LINE: an island that takes `page.data` whole (a spread, a
 * pass-through, `const d = page.data`) makes every key ship to the browser, in every page view.
 * The seed explainer knew WHICH islands; this points at the line in each that does it, with the
 * bytes it costs. A size, not a time: no saving in ms is claimed.
 */
export function seed_whole_pattern(
	readers: readonly WholeReader[],
	seed_bytes: number,
	top?: { key: string; bytes: number }
): Pattern | undefined {
	if (!readers.length || seed_bytes < 16 * 1024) return undefined;
	const names = readers.map((r) => r.name);
	const who =
		names.length <= 2
			? names.join(' and ')
			: `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
	return {
		kind: 'seed-whole-read',
		title: `An island takes page.data whole, so all of it ships${places(readers.length)}`,
		fix: 'Read the keys by name (page.data.price, not the whole object handed on), or pass the island only what it shows as props. Then seed shaping ships just those keys instead of everything the page loaded.',
		example: {
			before: 'const d = page.data; // then d.price, d.currency',
			after: 'const { price, currency } = page.data;'
		},
		sites: readers.map((r) => ({
			path: r.file,
			file: r.file,
			line: r.line,
			code: r.code,
			cpu_ms: 0,
			alloc_bytes: 0,
			gc_ms: 0,
			in_loop: false,
			fn_name: r.name,
			...(r.context ? { context: r.context } : {})
		})),
		cost_ms: 0,
		alloc_bytes: 0,
		save_ms: 0,
		evidence: `${who} take${names.length === 1 ? 's' : ''} page.data whole: the seed ships ${fmt_mb(seed_bytes)} with every page view${top ? ` (the biggest key: ${top.key}, ${fmt_mb(top.bytes)})` : ''}`,
		seed_bytes
	};
}

export interface ConstantWork {
	path: string;
	file: string;
	line: number;
	code: string;
	/** what the line names (`valid`) and the functions it runs */
	names: string[];
	calls: string[];
	/** CPU the line and its functions took, over every profiled render (ms) */
	cpu_ms: number;
	context?: PatternSite['context'];
}

/**
 * THE SAME WORK EVERY REQUEST: load lines whose value depends only on the module (source-scan
 * `constant_work`), with the CPU they took. The CPU twin of `same-answer`: every request computes
 * the same result again. Saving: all of it (computed once, at module load or on first use).
 */
export function same_work_pattern(
	work: readonly ConstantWork[],
	renders: number
): Pattern | undefined {
	const costly = work
		.filter((w) => w.cpu_ms / Math.max(1, renders) >= MIN_SAVE_MS)
		.sort((a, b) => b.cpu_ms - a.cpu_ms);
	if (!costly.length) return undefined;
	const cost = costly.reduce((s, w) => s + w.cpu_ms, 0);
	const top = costly[0];
	const per = (ms: number) => r2(ms / Math.max(1, renders));
	return {
		kind: 'same-every-request',
		title: `Every request computes the same thing again${places(costly.length)}`,
		fix: 'These lines read nothing the request brings — only the module’s own imports and constants — so every request gets the same result. Compute it once: at module level (`const VALID = validateAll(PRODUCTS)` next to the imports), or lazily on first use. If a function in it reads the clock, a random number or a file that changes, keep that part per request.',
		example: {
			before: 'export const load = () => {\n\tconst valid = validateAll(PRODUCTS);',
			after:
				'const VALID = validateAll(PRODUCTS); // once, when the module loads\nexport const load = () => {'
		},
		sites: costly.map((w) => ({
			path: w.path,
			file: w.file,
			line: w.line,
			code: w.code,
			cpu_ms: r2(w.cpu_ms),
			alloc_bytes: 0,
			gc_ms: 0,
			in_loop: false,
			...(w.calls.length ? { fn_name: w.calls[0], moves: w.calls } : {}),
			...(w.context ? { context: w.context } : {})
		})),
		cost_ms: r2(cost),
		alloc_bytes: 0,
		save_ms: r2(cost),
		evidence: `${top.names.join(', ')} (${top.calls.join(', ') || 'this line'}) reads only the module, yet runs on every request: ${per(top.cpu_ms)} ms a render${costly.length > 1 ? `; ${costly.length} such lines, ${per(cost)} ms a render in all` : ''}`
	};
}

export interface PerItemRender {
	/** the component rendered once per item, its renders in one render of the page and its time
	 *  over every profiled render */
	component: string;
	instances: number;
	total_ms: number;
	/** the `{#each}` that renders it */
	each: {
		path: string;
		file: string;
		line: number;
		code: string;
		context?: PatternSite['context'];
	};
	/** the page-data key the loop walks, and the load line that makes it */
	key?: string;
	made_at?: { path: string; file: string; line: number; code: string };
}

/**
 * A COMPONENT RENDERED ONCE PER ITEM: its render count (V8's count of one render) comes from an
 * `{#each}` over a page-data key, and that key is made on one load line (source). The chain says
 * where its time is decided: render fewer items (a page of them, a smaller slice), or make each
 * one cheaper. The cost scales with the count, so no saving is claimed: it is the lever, not a fix.
 */
export function render_per_item_pattern(
	items: readonly PerItemRender[],
	renders: number
): Pattern | undefined {
	const costly = items
		.filter((i) => i.total_ms / Math.max(1, renders) >= 5 && i.instances >= 20)
		.sort((a, b) => b.total_ms - a.total_ms);
	if (!costly.length) return undefined;
	const per = (ms: number) => r2(ms / Math.max(1, renders));
	const top = costly[0];
	return {
		kind: 'render-per-item',
		title: `A component renders once per item of a list${places(costly.length)}`,
		fix: 'Its time is its count times its cost. The count is set by the list the loop walks, which the load makes: send a page of items (pagination, a smaller slice, "load more" in an island) and the time drops in step. Or make each render cheaper: the slow patterns inside it say where.',
		example: {
			before: 'const results = sorted.slice(0, 120);',
			after: 'const results = sorted.slice(0, 24); // one page; the rest on request'
		},
		sites: costly.map((i) => ({
			path: i.each.path,
			file: i.each.file,
			line: i.each.line,
			code: i.each.code,
			cpu_ms: r2(i.total_ms),
			alloc_bytes: 0,
			gc_ms: 0,
			calls: i.instances,
			in_loop: true,
			fn_name: i.component,
			...(i.made_at
				? {
						via: [
							{
								path: i.made_at.path,
								file: i.made_at.file,
								line: i.made_at.line,
								code: i.made_at.code,
								in_loop: false
							}
						]
					}
				: {}),
			...(i.each.context ? { context: i.each.context } : {})
		})),
		cost_ms: r2(costly.reduce((s, i) => s + i.total_ms, 0)),
		alloc_bytes: 0,
		save_ms: 0,
		evidence: `${top.component} renders ${top.instances} times a page (${per(top.total_ms)} ms, ${r2(per(top.total_ms) / top.instances)} ms each)${top.key ? `: once per item of ${top.key}` : ''}${top.made_at ? `, made at ${top.made_at.file}:${top.made_at.line}` : ''}`
	};
}

/**
 * THE SAME DOCUMENT EVERY REQUEST: every profiled render returned the same bytes, and nothing it
 * reads is the visitor's (no load takes cookies, locals or the raw request; no outbound call carried
 * a cookie or an authorization header). The whole render can be skipped: a CDN keeps the document
 * (`Cache-Control: s-maxage`, keyed by its URL), or ogygia freezes it. Saving: the render itself.
 */
export function same_document_pattern(input: {
	file: string;
	render_ms: number;
	bytes: number;
	code?: string;
	/** what the response says that no shared cache accepts: a Set-Cookie, Cache-Control private / no-store */
	blocked?: { cookie?: boolean; cache_control?: string };
}): Pattern {
	const blocks = [
		...(input.blocked?.cookie ? ['sets a cookie (Set-Cookie)'] : []),
		...(input.blocked?.cache_control ? [`answers Cache-Control: ${input.blocked.cache_control}`] : [])
	];
	const first = blocks.length
		? ` First, the response ${blocks.join(' and ')}: no shared cache (a CDN, a proxy) keeps such a page, so the header below does nothing until that goes. ${input.blocked?.cookie ? 'Set the cookie where it is needed (an endpoint the page calls, a hook that skips this path) rather than on every page; ' : ''}${input.blocked?.cache_control ? 'drop private / no-store from a page that holds nothing per visitor; ' : ''}then`
		: '';
	return {
		kind: 'same-document',
		title: 'Every request renders the same page again',
		fix: `Every profiled render returned the same document byte for byte, and nothing it reads belongs to the visitor. Let a cache serve it instead of rendering it.${first} ${first ? 'set' : 'Set'} Cache-Control with s-maxage (a CDN keeps it per URL; stale-while-revalidate refreshes it in the background), or freeze the page with ogygia. Only a change in its data needs a new render. (A \`handle\` hook that reads cookies and changes the page would make it per visitor: the loads cannot show that, so check yours first.)`,
		example: {
			before: 'export const load = async ({ fetch }) => { … }',
			after:
				"export const load = async ({ fetch, setHeaders }) => {\n\tsetHeaders({ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' });\n\t…"
		},
		sites: [
			{
				path: input.file,
				file: input.file,
				line: 1,
				code: input.code ?? '',
				cpu_ms: 0,
				alloc_bytes: 0,
				gc_ms: 0,
				in_loop: false
			}
		],
		cost_ms: r2(input.render_ms),
		alloc_bytes: 0,
		save_ms: r2(input.render_ms),
		wait: true,
		evidence: `every render returned the same ${fmt_mb(input.bytes)} document; no load reads cookies, locals or the request, and no call carried a cookie: ~${Math.round(input.render_ms)} ms a request a cache would answer instead${blocks.length ? `, once the response no longer ${blocks.join(' and ')}` : ''}`
	};
}

/**
 * THE SAME PAGE BUT FOR A FEW PARTS: the renders' documents differ only in a few small groups (an
 * island's props, an id stamped per render, numbered comment markers) and nothing read is the
 * visitor's. Those parts are all that stands between the page and a cached copy: make them stop
 * changing (an id derived from the data, not a counter or a random; a live value fetched in the
 * browser or in a deferred region) and the whole render comes off.
 */
export function almost_same_document_pattern(input: {
	file: string;
	render_ms: number;
	diff: import('./doc-diff.js').DocDiff;
	code?: string;
}): Pattern {
	const g = input.diff.groups;
	const origin = (x: (typeof g)[number]) =>
		x.sources?.length
			? `, set at ${x.sources.map((s) => `${s.file}:${s.line}`).join(', ')}`
			: x.library
				? ', stamped by a library as it renders (no file of yours sets it)'
				: '';
	const parts = g.map(
		(x) =>
			`${x.what} (${x.count} place${x.count === 1 ? '' : 's'}: ${x.a || '""'} → ${x.b || '""'}${origin(x)})`
	);
	// the lines to open: where your markup sets each changing attribute
	const set_at = g.flatMap((x) => x.sources ?? []);
	return {
		kind: 'almost-same-document',
		title: `The page is the same every render but for ${g.length} small part${g.length === 1 ? '' : 's'}`,
		fix: 'Only these parts change from one render to the next; everything else is byte for byte the same, and nothing read belongs to the visitor. Make them stop changing — an id derived from the data instead of a counter or a random, a live value fetched in the browser or moved into a deferred region (`render: \'deferred\'`) — and the whole page can be a cached copy (then see "same page every request").',
		example: {
			before: '<a data-track={crypto.randomUUID()}>',
			after: '<a data-track={product.id}> <!-- the same every render -->'
		},
		sites: set_at.length
			? set_at.map((s) => ({
					path: s.file,
					file: s.file,
					line: s.line,
					code: s.code,
					cpu_ms: 0,
					alloc_bytes: 0,
					gc_ms: 0,
					in_loop: false
				}))
			: [
					{
						path: input.file,
						file: input.file,
						line: 1,
						code: input.code ?? '',
						cpu_ms: 0,
						alloc_bytes: 0,
						gc_ms: 0,
						in_loop: false
					}
				],
		cost_ms: r2(input.render_ms),
		alloc_bytes: 0,
		save_ms: r2(input.render_ms),
		wait: true,
		evidence: `${input.diff.differing} of ${input.diff.tokens} pieces of the document change between renders, all of them: ${parts.join('; ')}`
	};
}

export interface LateIslandWait {
	/** the wait (`GET api/reviews`), one render: its ms and the part nothing else was in flight */
	call: string;
	ms: number;
	alone: number;
	/** the load line that made it */
	at: { path: string; file: string; line: number; code: string };
	/** the key it fills, and the late island that alone uses it (where) */
	key: string;
	island: string;
	wake: string;
	use: { path: string; file: string; line: number; code: string };
}

/**
 * THE PAGE WAITS FOR A LATE ISLAND'S DATA: a call whose every key is used only as props of an island
 * that wakes late (`visible`, `idle`, `interaction`). Every request waits for it before the first
 * byte, for markup the visitor may never scroll to. Deferred (`render: 'deferred'`), the island
 * renders on the server when it wakes, with its own call: the page stops waiting. Saving: the
 * stretch the call held the render alone.
 */
export function late_island_pattern(items: readonly LateIslandWait[]): Pattern | undefined {
	const costly = items.filter((i) => i.alone >= MIN_SAVE_MS).sort((a, b) => b.alone - a.alone);
	if (!costly.length) return undefined;
	const top = costly[0];
	const save = costly.reduce((s, i) => s + i.alone, 0);
	return {
		kind: 'late-island-wait',
		title: `The page waits for data only a late island shows${places(costly.length)}`,
		fix: `The data feeds only an island that wakes later (${top.wake}), yet every request waits for it before sending a byte. Move the call into the island (a remote function it awaits) and import it deferred — \`with { render: 'deferred', wake: '${top.wake}' }\`: the page renders without it, and the island's HTML comes from the server when it wakes.`,
		example: {
			before: `import ${top.island} from './${top.island}.svelte' with { wake: '${top.wake}' };\n<${top.island} ${top.key}={data.${top.key}} />`,
			after: `import ${top.island} from './${top.island}.svelte' with { render: 'deferred', wake: '${top.wake}' };\n<${top.island} /> <!-- it fetches ${top.key} itself -->`
		},
		sites: costly.map((i) => ({
			path: i.at.path,
			file: i.at.file,
			line: i.at.line,
			code: i.at.code,
			cpu_ms: 0,
			alloc_bytes: 0,
			gc_ms: 0,
			in_loop: false,
			wait_ms: r2(i.ms),
			target: i.call,
			fn_name: i.island,
			via: [
				{ path: i.use.path, file: i.use.file, line: i.use.line, code: i.use.code, in_loop: false }
			]
		})),
		cost_ms: r2(costly.reduce((s, i) => s + i.ms, 0)),
		alloc_bytes: 0,
		save_ms: r2(save),
		wait: true,
		evidence: `${top.call} (${r2(top.ms)} ms, ${r2(top.alone)} ms of it alone) fills ${top.key}, used only by ${top.island} (wake: ${top.wake}) at ${top.use.file}:${top.use.line}`
	};
}

// ── one level in: inlined callees and loop bodies ─────────────────────────────

const NOT_CALLS: ReadonlySet<string> = new Set([
	'if',
	'for',
	'while',
	'switch',
	'return',
	'function',
	'catch',
	'typeof',
	'await',
	'new',
	'super',
	'import',
	'require'
]);

/** `a/b/../c` → `a/c` (a path is all this needs; no file system) */
function normalize(p: string): string {
	const out: string[] = [];
	for (const seg of p.split('/')) {
		if (seg === '..') out.pop();
		else if (seg !== '.') out.push(seg);
	}
	return out.join('/');
}

/** Where `name` is defined for code in `path`: a `function name(` / `const name =` in the file
 *  itself, else through its `import { name } from '…'` (relative or `$lib/`), in that file. */
function find_definition(
	source: SourceReader,
	path: string,
	name: string
): { path: string; line: number } | undefined {
	const in_file = (p: string): number | undefined => {
		const got = source(p, 1, 4000);
		if (!got) return undefined;
		for (let i = 0; i < got.lines.length; i++) {
			const t = tokens(got.lines[i]);
			for (let k = 0; k + 2 < t.length; k++) {
				if (t[k] === 'function' && t[k + 1] === name && t[k + 2] === '(') return got.start + i;
				if (
					(t[k] === 'const' || t[k] === 'let' || t[k] === 'var') &&
					t[k + 1] === name &&
					t[k + 2] === '='
				)
					return got.start + i;
			}
		}
		return undefined;
	};
	const here = in_file(path);
	if (here) return { path, line: here };
	const head = source(path, 1, 400);
	if (!head) return undefined;
	let names_in_import = false;
	for (const raw of head.lines) {
		const t = tokens(raw);
		if (t.includes('import')) names_in_import = false;
		if (t.includes(name) && (t.includes('import') || names_in_import || t.includes('from')))
			names_in_import = true;
		const from = raw.indexOf(' from ');
		if (from === -1 || !names_in_import) continue;
		names_in_import = false;
		const q = raw.slice(from + 6).trim();
		const spec = q.slice(1, q.indexOf(q[0], 1));
		let target: string;
		if (spec.startsWith('.')) target = normalize(path.slice(0, path.lastIndexOf('/') + 1) + spec);
		else if (spec.startsWith('$lib/')) {
			const src = path.lastIndexOf('/src/');
			if (src === -1) return undefined;
			target = path.slice(0, src + 5) + 'lib/' + spec.slice(5);
		} else return undefined;
		for (const p of [
			target,
			target + '.ts',
			target + '.js',
			target + '/index.ts',
			target + '/index.js'
		]) {
			const line = in_file(p);
			if (line) return { path: p, line };
		}
		return undefined;
	}
	return undefined;
}

/**
 * The costly line shows no shape, but optimised code may have charged it someone else's time:
 * a loop header carries its body's (the body's calls inlined into it), a call carries the called
 * function's (inlined). Run the line rules over the loop's block, or the called app function's
 * body, with the costly line's cost and a per-item context, and return the first line that has a
 * shape. Library rules are left out: library time belongs to the line that was measured.
 */
function look_inside(
	source: SourceReader,
	l: LedgerLine,
	t: readonly string[],
	body: readonly string[],
	svelte: boolean,
	ctx: Ctx
): { rule: Rule; path: string; line: number; code: string; via: boolean } | undefined {
	const try_lines = (
		path: string,
		start: number,
		lines: readonly string[],
		per_item: boolean,
		via: boolean
	) => {
		const locals = intl_locals(lines);
		const text = text_locals(lines);
		const rx_locals = regexp_locals(lines, start);
		for (let i = 0; i < lines.length; i++) {
			const code = lines[i].trim();
			if (!code || code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
			const from = per_item ? 0 : loop_from(lines.slice(0, i + 1), path.endsWith('.svelte'));
			// repeated when the whole callee runs per item, or this line sits in the callee's own loop
			const c: Ctx = {
				...ctx,
				loop: from >= 0,
				from,
				repeated: per_item || from >= 0,
				lib_ms: 0,
				pkg_ms: 0,
				lib_names: [],
				// the outer line's calls are not this line's: a function run once per render, with a
				// callee inlined that runs per item, would read one "call" holding every item's bytes
				per_call_ms: undefined,
				per_call_bytes: undefined,
				intl_locals: locals,
				text_locals: text,
				regexp_locals: rx_locals,
				after: lines.slice(i + 1, i + 4)
			};
			const tl = tokens(lines[i]);
			for (const rule of RULES) {
				if (rule.kind === 'library-per-item' || rule.kind === 'sync-io') continue;
				if (rule.match(tl, c)) {
					// (a RegExp's first use: the site is the line that built it)
					const built = rule.kind === 'regexp-per-call' && !constructs(tl, REGEXP) ? used_local_regexp(tl, rx_locals) : undefined;
					const said = built?.code ?? code;
					return {
						rule,
						path,
						line: built?.line ?? start + i,
						code: said.length > 140 ? said.slice(0, 139) + '…' : said,
						via
					};
				}
			}
		}
		return undefined;
	};
	// a loop header: its block, every line of it per item
	if (t[0] === 'for' || t[0] === 'while') {
		const block = function_body(source, l.path, l.line, 120);
		if (block && block.lines.length > 1) {
			const hit = try_lines(l.path, block.start + 1, block.lines.slice(1), true, false);
			if (hit) return hit;
		}
	}
	// a call on the line: the called app function's body — even from a line that runs once, since a
	// whole function inlined into its caller brings its own loops with it. The callee's lines run
	// per item when this line does (a loop, a callback, a sort comparator: n log n times), else only
	// inside the callee's own loops
	const per_item = ctx.repeated || ctx.loop || t.includes('sort') || t.includes('toSorted');
	const seen = new Set<string>();
	for (let k = 0; k + 1 < t.length && seen.size < 3; k++) {
		const name = t[k];
		if (
			t[k + 1] !== '(' ||
			seen.has(name) ||
			NOT_CALLS.has(name) ||
			t[k - 1] === '.' ||
			t[k - 1] === '?.' ||
			t[k - 1] === 'new' ||
			t[k - 1] === 'function'
		)
			continue;
		if (!is_word_start(name.charCodeAt(0))) continue;
		seen.add(name);
		const def = find_definition(source, l.path, name);
		if (!def || (def.path === l.path && def.line === l.line)) continue;
		const fb = function_body(source, def.path, def.line, 200);
		if (!fb) continue;
		const hit = try_lines(def.path, fb.start, fb.lines, per_item, true);
		if (hit) return hit;
	}
	void body;
	void svelte;
	return undefined;
}

// ── caches that never hit ─────────────────────────────────────────────────────

export interface ColdCacheInput {
	functions: readonly FrameStat[];
	/** V8's call counts from the coverage render: `<name>\0<script url>` → calls */
	call_counts: Readonly<Record<string, number>>;
	source: SourceReader;
}

/** a memo runs at least this often, and costs this much, before it is judged */
const COLD_MIN_CALLS = 10;
const COLD_MIN_MS = 1;
/** hits under this share of calls: the cache does not work */
const COLD_MAX_HIT_SHARE = 0.1;

/**
 * THE CACHE THAT NEVER HITS: an app function with a memo shape — a lookup (`M.get(k)`,
 * `M.has(k)`), an early `return` of the hit, and a store (`M.set(k, …)`) after the work — whose
 * MISS PATH ran about as often as the function itself. Measured from V8's call counts, which
 * survive inlining: a helper the miss path calls once (not in a loop), and nothing else calls,
 * ran once per miss; its count against the memo's is the miss rate. (Block counts would say it
 * directly, but V8 only instruments functions compiled after they are switched on.)
 */
export function find_cold_caches(input: ColdCacheInput): Pattern | undefined {
	// a name's count, when exactly one script has a function of that name (else it is ambiguous)
	const by_name = new Map<string, number | null>();
	for (const [k, n] of Object.entries(input.call_counts)) {
		const at = k.indexOf('\0');
		// (a count is also kept by script id, `name\0#<id>`: the same function, not another one)
		if (k[at + 1] === '#') continue;
		const name = k.slice(0, at);
		by_name.set(name, by_name.has(name) ? null : n);
	}
	const fn_by_name = new Map<string, FrameStat>();
	for (const f of input.functions) if (!fn_by_name.has(f.name)) fn_by_name.set(f.name, f);
	const sites: PatternSite[] = [];
	for (const f of input.functions) {
		const calls = f.calls ?? 0;
		if (
			(f.category !== 'app' && f.category !== 'component') ||
			calls < COLD_MIN_CALLS ||
			f.total_ms < COLD_MIN_MS ||
			f.line <= 0
		)
			continue;
		const body = function_body(input.source, f.path, f.line, 200);
		if (!body) continue;
		// the memo shape: lookup on M, an early return, a store on M
		let get_line = 0;
		let return_line = 0;
		let set_line = 0;
		let map = '';
		for (let i = 0; i < body.lines.length && !set_line; i++) {
			const t = tokens(body.lines[i]);
			const line = body.start + i;
			for (let k = 2; k + 1 < t.length; k++) {
				if (t[k - 1] !== '.' || t[k + 1] !== '(') continue;
				if (!get_line && (t[k] === 'get' || t[k] === 'has')) ((get_line = line), (map = t[k - 2]));
				else if (get_line && t[k] === 'set' && t[k - 2] === map) set_line = line;
			}
			if (get_line && !return_line && !set_line && t.includes('return')) return_line = line;
		}
		if (!get_line || !return_line || !set_line) continue;
		// the miss path: from after the early return up to the store; its helpers called once
		const miss = body.lines.slice(return_line - body.start + 1, set_line - body.start + 1);
		let misses: number | undefined;
		let helper = '';
		for (let i = 0; i < miss.length; i++) {
			if (loop_from(miss.slice(0, i + 1)) >= 0) continue;
			const t = tokens(miss[i]);
			for (let k = 0; k + 1 < t.length; k++) {
				const name = t[k];
				if (
					t[k + 1] !== '(' ||
					NOT_CALLS.has(name) ||
					t[k - 1] === '.' ||
					t[k - 1] === '?.' ||
					t[k - 1] === 'new' ||
					name === f.name
				)
					continue;
				if (!is_word_start(name.charCodeAt(0))) continue;
				const n = by_name.get(name);
				// a helper that ran more often than the memo is called from elsewhere too: no measure
				if (n === null || n === undefined || n > calls) continue;
				// and its sampled callers, when known, must be this memo
				const g = fn_by_name.get(name);
				const caller = g?.stacks?.[0]?.frames.find((x) => x.c === 'app' || x.c === 'component');
				if (caller && caller.n !== f.name) continue;
				if (misses === undefined || n > misses) ((misses = n), (helper = name));
			}
		}
		if (misses === undefined) continue;
		const hits = calls - misses;
		if (hits / calls >= COLD_MAX_HIT_SHARE) continue;
		const code = body.lines[get_line - body.start]?.trim() ?? '';
		sites.push({
			path: f.path,
			file: f.url || short_file(f.path),
			line: get_line,
			code: code.length > 140 ? code.slice(0, 139) + '…' : code,
			fn: f.key,
			fn_name: f.name,
			cpu_ms: f.total_ms,
			alloc_bytes: 0,
			gc_ms: 0,
			calls,
			hits: Math.max(0, hits),
			in_loop: false,
			target: helper,
			...ctx_field(input.source, f.path, get_line)
		});
	}
	if (!sites.length) return undefined;
	sites.sort((a, b) => b.cpu_ms - a.cpu_ms);
	const top = sites[0];
	const cost = sites.reduce((s, x) => s + x.cpu_ms, 0);
	return {
		kind: 'cache-never-hits',
		title: sites.every((s) => s.hits === 0)
			? `A cache never hits${places(sites.length)}`
			: `A cache almost never hits${places(sites.length)}`,
		fix: 'Every call misses, does the work, and stores a result nobody reads back. Check the key: a cache keyed by an object only hits for that same object, so a fresh copy ({ ...p }, structuredClone) or a new instance per call misses every time. Key it by a stable id, pass the original object, share one cache, or remove it.',
		example: {
			before:
				'const vm = new WeakMap(); … toVM({ ...product }) // a new object every call: always a miss',
			after:
				'const vm = new Map(); … vm.get(product.id) ?? vm.set(product.id, build(product)).get(product.id)'
		},
		sites,
		cost_ms: r2(cost),
		alloc_bytes: 0,
		// a working cache would skip the work on repeat inputs; how many repeat is not known, so
		// the saving is not claimed
		save_ms: 0,
		evidence: `${top.fn_name} ran ${top.calls} times in one render and its cache answered ${top.hits} of them (${top.target}, which only the miss path calls, ran ${top.calls! - top.hits!} times)`
	};
}
