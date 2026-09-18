/**
 * REGIONS in the SSR HTML, for an app that runs a THIRD-PARTY SSR/hydration pass over the final
 * document (a Stencil / web-component server-render, a translation proxy, an A/B injector). The one
 * integration rule such a pass must honour: **never reshape the bytes inside an island.** An island
 * hydrates against its exact server markup; a reshaped node sequence makes the hydration walk
 * mismatch, so the island discards its server DOM and re-renders client-side, and the first
 * interaction lands on the discarded tree (the classic tell: a dropdown that needs two clicks).
 * Lakes and holes are NOT hydrated — their bytes are safe to touch.
 *
 * Apps that hand-rolled this with a regex balance-count (`<ogygia-region>` opens vs closes) get
 * fooled by tag-like TEXT: a literal `<ogygia-region>` inside a CSS comment in an inlined `<style>`,
 * or an HTML comment, or an attribute value, throws the count off, the island skip silently stops
 * applying, and the pass reshapes island bytes — in dev but not in prod (where the comment minifies
 * away), so it passes every local test and breaks on the deploy.
 *
 * `scanRegions(html)` is a generator, not a regex: it tracks REAL element nesting of `<ogygia-region>`
 * and skips `<!-- … -->`, the raw-text bodies of `<script>` / `<style>`, and quoted attribute
 * values, so tag-like text in any of those is never counted. Each region is yielded once, a region
 * AFTER the regions nested inside it (post-order, by closing-tag position). An island's own span is
 * yielded — including an island nested inside a lake or hole, the header-lake login island being
 * exactly that case, so the caller can protect it — but the regions STRICTLY INSIDE an island are
 * not, because a reshape anywhere in an island's subtree breaks the same hydration walk.
 *
 * The pattern this is built for, robust at any nesting depth: protect every island's bytes, edit
 * everything else.
 *
 * ```ts
 * import { scanRegions } from 'ogygia/server';
 * const protect = [];
 * for (const r of scanRegions(html)) {
 *   if (r.kind === 'island') protect.push([r.start, r.end]); // its bytes stay verbatim
 * }
 * // reshape `html` everywhere EXCEPT the protected ranges …
 * ```
 *
 * If you edit by offset instead, splice in reverse `start` order so earlier offsets stay valid:
 * `[...scanRegions(html)].sort((a, b) => b.start - a.start)`.
 *
 * Malformed input never throws and never loses a region: an unterminated `<ogygia-region>` (no
 * matching close) is still yielded, with `innerStart === innerEnd` and `end` at the `>` of its
 * opening tag — i.e. its span is just the opening tag. A caller reshaping `[innerStart, innerEnd)`
 * of such a region edits nothing, which is the safe outcome.
 *
 * For the FULL round-trip — lift the regions out, run the foreign renderer over what is left, splice
 * them back — use {@link liftRegions} / {@link restoreRegions} (below). Restore transplants the marks
 * a scoped renderer stamps on the placeholder onto the region, unions `class`, and touches only
 * attributes, never light DOM. All three are also exported, Kit-free, from `ogygia/rewrite`, for the
 * non-SvelteKit half of a monorepo where these SSR passes usually live.
 */

export type RegionKind = 'island' | 'lake' | 'hole';

export interface RegionSpan {
	/** `island` = a hydrated region (its bytes are off-limits to any post-SSR reshaping); `lake` = a
	 *  frozen (`wake="none"`) subtree, server HTML the browser never re-creates; `hole` = a deferred
	 *  region whose current markup is the page's fallback, not a hydration tree. */
	kind: RegionKind;
	/** Index of the `<` that opens `<ogygia-region …>`. */
	start: number;
	/** Index one past the `>` that closes `</ogygia-region>`. `[start, end)` is the whole element. */
	end: number;
	/** Index one past the `>` of the OPENING tag — the first byte of the region's inner HTML. */
	innerStart: number;
	/** Index of the `<` of the CLOSING tag — one past the last byte of the inner HTML.
	 *  `[innerStart, innerEnd)` is the inner HTML a reshaping pass may edit for a lake / hole. */
	innerEnd: number;
	/** The opening tag's attributes (unquoted values). Read `wake` / `endpoint` / `entry` here. */
	attrs: Readonly<Record<string, string>>;
	/** Nesting depth — `0` for a top-level region, `1` for one directly inside a lake / hole, and so
	 *  on. Island subtrees are never entered, so a region deeper than `0` is always inside a lake or
	 *  hole (never inside another island). */
	depth: number;
}

const REGION_TAG = 'ogygia-region';
const RAW_TEXT_TAGS = ['script', 'style'] as const;

/** ASCII whitespace that can follow a tag name. */
function is_space(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/** ASCII letter — what a real tag name begins with (`<a…` / `</a…`). A `<` followed by anything
 *  else (space, digit, `=`) is text, not a tag, per the HTML tokenizer. */
function is_ascii_alpha(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** True when `tag`'s NAME sits at `name` as a real element name (followed by whitespace, `>`, or
 *  `/`), case-insensitive — so `ogygia-region-foo` or `styles` don't match a shorter tag. Callers
 *  pass the index of the tag name: for `<tag` that is `i + 1`, for `</tag` it is `i + 2`. */
function name_at(html: string, name: number, tag: string): boolean {
	if (html.slice(name, name + tag.length).toLowerCase() !== tag) return false;
	const after = html.charCodeAt(name + tag.length);
	return Number.isNaN(after) || is_space(after) || after === 62 /* > */ || after === 47; /* / */
}

/** True when an OPENING tag `<tag…` starts at `i`. */
function open_tag_at(html: string, i: number, tag: string): boolean {
	return html.charCodeAt(i) === 60 /* < */ && name_at(html, i + 1, tag);
}

/** True when a CLOSING tag `</tag…` starts at `i`. */
function close_tag_at(html: string, i: number, tag: string): boolean {
	return html.charCodeAt(i) === 60 && html.charCodeAt(i + 1) === 47 && name_at(html, i + 2, tag);
}

/** Index of the `>` that ends the tag whose `<` is at `open`, respecting `"…"` / `'…'` attribute
 *  values (a `>` inside a value does not end the tag). `html.length` if the tag is unterminated. */
function tag_end(html: string, open: number): number {
	let quote = 0;
	for (let i = open + 1; i < html.length; i++) {
		const c = html.charCodeAt(i);
		if (quote) {
			if (c === quote) quote = 0;
		} else if (c === 34 || c === 39) {
			quote = c;
		} else if (c === 62 /* > */) {
			return i;
		}
	}
	return html.length;
}

/** Index of the `<` of the closing `</style>` / `</script>` at or after `from`, or -1. Allocation
 *  free: a native `indexOf('<')` scan (SIMD-fast in V8) plus a bounded tag check — never a substring
 *  copy or a per-call RegExp (this runs once per raw-text element on every SSR response, some of
 *  them megabytes). */
function raw_text_end(html: string, from: number, tag: 'script' | 'style'): number {
	let at = from;
	for (;;) {
		const lt = html.indexOf('<', at);
		if (lt === -1) return -1;
		if (close_tag_at(html, lt, tag)) return lt;
		at = lt + 1;
	}
}

const ATTR_RE = /([^\s/>=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s/>]+))?/g;

/** Parse a tag's attribute run (everything between the tag name and its `>`) into a lower-cased map
 *  with quotes stripped. Shared by the region opener and the `<og-lift>` placeholder on restore. */
function parse_attr_string(inner: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	ATTR_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ATTR_RE.exec(inner))) {
		let value = m[2] ?? '';
		if (value && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
		attrs[m[1].toLowerCase()] = value;
	}
	return attrs;
}

/** Parse the attributes out of an opening tag whose `<` is at `open` and `>` at `gt`. */
function parse_attrs(html: string, open: number, gt: number): Record<string, string> {
	return parse_attr_string(html.slice(open + 1 + REGION_TAG.length, gt));
}

/** The classification the whole framework agrees on (runtime region-attrs, the compiled tag): a
 *  region with an `endpoint` is a deferred HOLE; `wake="none"` is a frozen LAKE; anything else that
 *  wakes is an ISLAND. Matches `region_hydrate_schedule` / `is_deferred` / `is_frozen`. */
function classify(attrs: Record<string, string>): RegionKind {
	if ('endpoint' in attrs) return 'hole';
	if (attrs.wake === 'none') return 'lake';
	return 'island';
}

interface OpenFrame {
	node: RegionSpan;
	/** Emit this region at its close? An island IS yielded (so a caller protects its bytes — the
	 *  login island nested in a header lake is exactly this case); the regions STRICTLY INSIDE an
	 *  island are not. */
	emit: boolean;
	/** Suppress the regions nested inside this one — true for an island and anything within it. Its
	 *  matching `</ogygia-region>` still balances the scan, it just yields nothing. */
	sealed: boolean;
}

/**
 * Yield every `<ogygia-region>` in `html`, in document order, an island's subtree treated as atomic
 * (its nested regions are not yielded). One linear pass, O(html length); allocates no copy of the
 * document. See the module doc for why this exists and how to use it.
 */
export function* scanRegions(html: string): Generator<RegionSpan, void, undefined> {
	const stack: OpenFrame[] = [];
	const n = html.length;
	let i = 0;

	while (i < n) {
		// Jump straight to the next `<` — `indexOf` is a native scan (SIMD-fast in V8), so the long
		// text runs between tags on a big CMS page are skipped without a per-char JS loop.
		const lt = html.indexOf('<', i);
		if (lt === -1) break;
		i = lt;
		// `<!-- … -->`: tag-like text inside a comment is not markup.
		if (html.startsWith('<!--', i)) {
			const close = html.indexOf('-->', i + 4);
			i = close === -1 ? n : close + 3;
			continue;
		}
		// `<script>` / `<style>`: raw-text elements. Skip the whole element — a `<ogygia-region>` in a
		// CSS comment (the reported bug) or a script string lives here and must not be counted.
		let raw: (typeof RAW_TEXT_TAGS)[number] | null = null;
		for (const t of RAW_TEXT_TAGS) if (open_tag_at(html, i, t)) raw = t;
		if (raw) {
			const gt = tag_end(html, i);
			if (html.charCodeAt(gt - 1) === 47 /* /> self-closing */) {
				i = gt + 1;
				continue;
			}
			const close = raw_text_end(html, gt + 1, raw);
			i = close === -1 ? n : tag_end(html, close) + 1;
			continue;
		}
		// Closing `</ogygia-region>`.
		if (close_tag_at(html, i, REGION_TAG)) {
			const gt = tag_end(html, i);
			const frame = stack.pop();
			if (frame?.emit) {
				frame.node.innerEnd = i;
				frame.node.end = gt + 1;
				yield frame.node;
			}
			i = gt + 1;
			continue;
		}
		// Opening `<ogygia-region …>`.
		if (open_tag_at(html, i, REGION_TAG)) {
			const gt = tag_end(html, i);
			const parent_sealed = stack.length > 0 && stack[stack.length - 1].sealed;
			const attrs = parse_attrs(html, i, gt);
			const kind = classify(attrs);
			const self_closing = html.charCodeAt(gt - 1) === 47;
			// Emit this region unless it is STRICTLY INSIDE an island (a nested login island in a
			// header lake IS emitted — the caller must protect it). Its own subtree is sealed when it
			// is an island, or when it already sits inside one.
			const emit = !parent_sealed;
			const sealed = parent_sealed || kind === 'island';
			const node: RegionSpan = {
				kind,
				start: i,
				end: gt + 1, // filled at the close; a self-closed / unterminated region keeps this
				innerStart: gt + 1,
				innerEnd: gt + 1,
				attrs,
				depth: stack.length
			};
			if (self_closing) {
				if (emit) yield node; // no subtree to seal
			} else {
				stack.push({ node, emit, sealed });
			}
			i = gt + 1;
			continue;
		}
		// Any OTHER real tag (`<div …>`, `</p>`, a `<qds-*>` block): skip past its whole tag with
		// `tag_end`, which respects quoted attribute values — so a literal `<ogygia-region>` sitting
		// INSIDE another element's attribute (`<div data-note="<ogygia-region>">`) is never scanned
		// as content. A `<` that does not begin a tag (a stray `<` in text, e.g. `a < b`) advances one.
		const c1 = html.charCodeAt(i + 1);
		const starts_tag =
			is_ascii_alpha(c1) || (c1 === 47 /* / */ && is_ascii_alpha(html.charCodeAt(i + 2)));
		i = starts_tag ? tag_end(html, i) + 1 : i + 1;
	}
	// Unterminated regions (malformed HTML) drain here without a close — surfaced with their
	// parse-time `end`/`innerEnd` so a caller never loses a region silently.
	while (stack.length) {
		const frame = stack.pop()!;
		if (frame.emit) yield frame.node;
	}
}

// ─── lift / restore: the region round-trip for a third-party SSR pass ──────────────────────────
//
// The recurring shape (see the module doc) is not "read regions" but "run a foreign renderer over a
// page that CONTAINS regions, then put the regions back". That is three moves — lift the regions out
// to placeholders, let the renderer reshape only what is left, splice the regions back — and every
// integrator that hand-rolls the splice rediscovers the same two traps:
//   1. the renderer STAMPS marks on the placeholder (a scoped `::slotted` rule compiles to a
//      `.sc-<tag>-s` class plus `c-id` / `s-sn` on the slot child) — lost unless transplanted onto
//      the region it stands for, so the region comes back unstyled or inert;
//   2. the placeholder must be matched LOOSELY on restore, because the renderer just added those
//      attributes — an anchor on `data-i="N">` no longer matches and the region silently vanishes.
// `liftRegions` / `restoreRegions` own both, so the knowledge lives here once. The placeholder is an
// ELEMENT, not a comment, so a renderer that drops leading comments (parse5 does) can't drop it; and
// restore merges only OPENING-TAG attributes, never the region's light DOM, so it cannot shift the
// child-index sequence an island — or an island nested in a lifted lake — hydrates against.

const LIFT_TAG = 'og-lift';

// The `<og-lift>` placeholder, matched LOOSELY: the foreign renderer annotates it, so anchor only on
// the tag name and consume an optional close.
const LIFT_PLACEHOLDER_RE = /<og-lift\b([^>]*)>(?:<\/og-lift>)?/gi;
// Split an attribute value into whitespace-separated tokens (class lists).
const WS_SPLIT_RE = /\s+/;
// The region opening tag's own `class="…"` attribute, for a class-token union on restore.
const CLASS_ATTR_RE = /(\sclass\s*=\s*)("[^"]*"|'[^']*'|[^\s/>]+)/i;
// A trailing self-closing `/` (with surrounding space) at the end of an opening-tag head.
const TRAILING_SELF_CLOSE_RE = /\s*\/\s*$/;
// Trailing whitespace at the end of an opening-tag head.
const TRAILING_WS_RE = /\s+$/;
// Attribute-value escapes for re-emitting a transplanted mark.
const AMP_RE = /&/g;
const DQUOT_RE = /"/g;

export interface LiftedRegion {
	/** `island` bytes must be restored VERBATIM (reshaping them breaks hydration); a `lake` / `hole`
	 *  MAY be reshaped first via {@link LiftedRegion.withInner}. */
	readonly kind: RegionKind;
	/** The opening tag's attributes (`wake` / `endpoint` / `entry` …), lower-cased. */
	readonly attrs: Readonly<Record<string, string>>;
	/** `<ogygia-region …>` — the opening tag, verbatim. */
	readonly openTag: string;
	/** The region's inner HTML (`''` for a self-closed or unterminated region). */
	readonly innerHtml: string;
	/** `</ogygia-region>` — the closing tag (`''` for a self-closed or unterminated region). */
	readonly closeTag: string;
	/** `openTag + innerHtml + closeTag`. */
	readonly outerHtml: string;
	/** Ties this region to its `<og-lift data-i="…">` placeholder in the shell. */
	readonly index: number;
	/** A copy with the inner HTML replaced — for a lake / hole whose inner a caller has rendered. The
	 *  opening / closing tags and the index are preserved. Do NOT call this for an island. */
	withInner(innerHtml: string): LiftedRegion;
}

export interface LiftResult {
	/** The document with every TOP-LEVEL region replaced by an `<og-lift data-i="…"></og-lift>`
	 *  placeholder — the only part a foreign renderer should be handed. */
	shell: string;
	/** The lifted regions, in document order, index-aligned to their placeholders. */
	regions: LiftedRegion[];
}

function make_region(
	kind: RegionKind,
	attrs: Readonly<Record<string, string>>,
	openTag: string,
	innerHtml: string,
	closeTag: string,
	index: number
): LiftedRegion {
	return {
		kind,
		attrs,
		openTag,
		innerHtml,
		closeTag,
		outerHtml: openTag + innerHtml + closeTag,
		index,
		withInner(next: string): LiftedRegion {
			return make_region(kind, attrs, openTag, next, closeTag, index);
		}
	};
}

/**
 * Lift every TOP-LEVEL `<ogygia-region>` out of `html`, leaving an `<og-lift>` placeholder where each
 * was. Hand `shell` to the foreign renderer (and, to render a lake / hole, its `innerHtml` — recurse
 * with `liftRegions` there so islands nested inside it stay protected), then {@link restoreRegions}.
 * Islands come back verbatim. A region deeper than top level rides inside its parent's `outerHtml`.
 */
export function liftRegions(html: string): LiftResult {
	const regions: LiftedRegion[] = [];
	if (!html.includes(`<${REGION_TAG}`)) return { shell: html, regions };

	let shell = '';
	let cursor = 0;
	for (const span of scanRegions(html)) {
		if (span.depth !== 0) continue; // top-level only; nested regions travel inside outerHtml
		const openTag = html.slice(span.start, span.innerStart);
		const innerHtml = html.slice(span.innerStart, span.innerEnd);
		const closeTag = html.slice(span.innerEnd, span.end);
		const index = regions.length;
		shell += html.slice(cursor, span.start) + `<${LIFT_TAG} data-i="${index}"></${LIFT_TAG}>`;
		regions.push(make_region(span.kind, span.attrs, openTag, innerHtml, closeTag, index));
		cursor = span.end;
	}
	if (regions.length === 0) return { shell: html, regions };
	return { shell: shell + html.slice(cursor), regions };
}

/** Escape a value for re-emission inside a double-quoted attribute. */
function escape_attr(value: string): string {
	return value.replace(AMP_RE, '&amp;').replace(DQUOT_RE, '&quot;');
}

/** Merge the renderer's `class` marks into the region's opening-tag head, unioning tokens with any
 *  class the region already carries. Returns the head unchanged when nothing new is added. */
function merge_class(head: string, existing: string | undefined, added: string): [string, boolean] {
	const added_tokens = added.split(WS_SPLIT_RE).filter(Boolean);
	if (added_tokens.length === 0) return [head, false];
	if (existing === undefined) return [`${head} class="${escape_attr(added)}"`, true];

	const have = new Set(existing.split(WS_SPLIT_RE).filter(Boolean));
	let changed = false;
	for (const token of added_tokens)
		if (!have.has(token)) {
			have.add(token);
			changed = true;
		}
	if (!changed) return [head, false];

	const merged = [...have].join(' ');
	const rewritten = head.replace(
		CLASS_ATTR_RE,
		(_m, prefix: string) => `${prefix}"${escape_attr(merged)}"`
	);
	return [rewritten, true];
}

/** Transplant a placeholder's renderer-stamped marks onto the region's opening tag. Only marks the
 *  region does not already own are added; `class` is unioned; the region's light DOM is untouched. */
function merge_marks(region: LiftedRegion, marks: Record<string, string>): string {
	const gt = region.openTag.lastIndexOf('>');
	if (gt === -1) return region.outerHtml; // defensive: not a well-formed opening tag

	let head = region.openTag.slice(0, gt).replace(TRAILING_SELF_CLOSE_RE, '').replace(TRAILING_WS_RE, '');
	const additions: string[] = [];
	let changed = false;

	for (const name in marks) {
		if (name === 'data-i') continue;
		if (name === 'class') {
			const [next, did] = merge_class(head, region.attrs.class, marks.class);
			head = next;
			changed ||= did;
			continue;
		}
		if (name in region.attrs) continue; // never clobber the region's own attribute
		additions.push(`${name}="${escape_attr(marks[name])}"`);
		changed = true;
	}

	if (!changed) return region.outerHtml; // no marks to carry — keep the region byte-for-byte
	const open = additions.length ? `${head} ${additions.join(' ')}>` : `${head}>`;
	return open + region.innerHtml + region.closeTag;
}

/**
 * Splice lifted regions back over their `<og-lift>` placeholders, transplanting any attributes the
 * foreign renderer stamped on a placeholder (scoped slot marks — a `sc-*` class, `c-id`, `s-sn`)
 * onto the region's opening tag. The placeholder is matched loosely because the renderer annotates
 * it; only opening-tag attributes are merged, never the region's light DOM. An unknown placeholder
 * is left in place rather than dropped.
 */
export function restoreRegions(shell: string, regions: readonly LiftedRegion[]): string {
	if (regions.length === 0) return shell;
	const by_index = new Map(regions.map((r) => [r.index, r]));
	LIFT_PLACEHOLDER_RE.lastIndex = 0;
	return shell.replace(LIFT_PLACEHOLDER_RE, (whole, raw: string) => {
		const marks = parse_attr_string(raw);
		const region = by_index.get(Number(marks['data-i']));
		return region === undefined ? whole : merge_marks(region, marks);
	});
}
