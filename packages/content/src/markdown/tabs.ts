/**
 * Markdown-native tab groups — two authoring syntaxes, both rewritten (a RAW-TEXT pass, before
 * mdsvex) to the ogygia `<TabGroup>` / `<Tab>` components. The components are AUTO-INJECTED into the
 * module scope by the preprocessor when this pass fires, so authors write zero imports.
 *
 * **`::: code-group`** — VitePress-compatible. Each fenced block carries its tab label in the info
 * string as `[label]`; the label is stripped so Shiki still sees a clean language.
 *
 *   ::: code-group
 *   ```bash [npm]
 *   npm i ogygia
 *   ```
 *   ```bash [pnpm]
 *   pnpm add ogygia
 *   ```
 *   :::
 *
 * **`::: tabs`** — any content, one tab per `== Label` marker line.
 *
 *   ::: tabs
 *   == npm
 *   Run `npm i ogygia`.
 *   == pnpm
 *   Run `pnpm add ogygia`.
 *   :::
 *
 * **Shared memory.** A `code-group` defaults its `group` to its label set (so every "npm / pnpm /
 * yarn" block on the page switches together — pick your package manager once). A `tabs` block
 * defaults to a per-block group (independent). Either can name the group explicitly:
 * `::: code-group pm` / `::: tabs install`.
 *
 * **Robustness.** The scan is FENCE-AWARE at every level: a literal `:::`, `== …`, or `[label]` that
 * appears inside a fenced code sample is never treated as markup. Fence length is respected
 * (CommonMark: a closer must be at least as long as its opener and the same character). Line endings
 * are normalized (CRLF / lone CR / LF) before scanning, so a trailing `\r` can't defeat the anchored
 * patterns. Malformed input is tolerated, never thrown on — an unclosed block runs to EOF, an
 * unclosed fence runs to the block end (and is closed synthetically so the emitted markdown stays
 * well-formed), a fence with no `[label]` falls back to `Tab N`, an empty block emits nothing.
 */

const OPEN_CODE = /^\s*:::\s*code-group\b[ \t]*(.*?)\s*$/;
const OPEN_TABS = /^\s*:::\s*tabs\b[ \t]*(.*?)\s*$/;
const CLOSE = /^\s*:::\s*$/;
const TAB_MARK = /^\s*==[ \t]+(.+?)[ \t]*$/;
// A fence opener: optional indent, 3+ of ` or ~, then an info string (may be empty).
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const TAB_OPENER_RE = /(^|\n)\s*:::\s*(code-group|tabs)\b/;
const LINE_BREAK_RE = /\r\n|\r|\n/;
const BRACKET_LABEL_RE = /\[([^\]]*)\]/;
const AMP_G = /&/g;
const DOUBLE_QUOTE_G = /"/g;
const LT_G = /</g;
const GT_G = />/g;

const attr = (s: string) =>
	s
		.replace(AMP_G, '&amp;')
		.replace(DOUBLE_QUOTE_G, '&quot;')
		.replace(LT_G, '&lt;')
		.replace(GT_G, '&gt;');

/** An open fence's identity: its char (` or ~) and length, so we only close on a matching-or-longer run. */
type Fence = { char: string; len: number };

/** If `line` opens a fence, return its identity + info string; else null. */
function fence_open(line: string): { fence: Fence; indent: string; info: string } | null {
	const m = FENCE.exec(line);
	if (!m) return null;
	return { fence: { char: m[2][0], len: m[2].length }, indent: m[1], info: m[3] };
}

/** True if `line` closes `open`: same char, run length ≥ opener, nothing but whitespace after. */
function fence_close(line: string, open: Fence): boolean {
	const m = FENCE.exec(line);
	if (!m) return false;
	return m[2][0] === open.char && m[2].length >= open.len && m[3].trim() === '';
}

export type TabsResult = { code: string; used: boolean };

/** True if the source contains a tab-group opener (cheap gate to skip the pass). */
export function has_tabs(src: string): boolean {
	return TAB_OPENER_RE.test(src);
}

/**
 * Rewrite `::: code-group` / `::: tabs` blocks to `<TabGroup>`/`<Tab>`. `used` flags whether any fired
 * (so the caller injects the component import only when needed). Never throws.
 */
export function transform_tabs(src: string): TabsResult {
	if (!has_tabs(src)) return { code: src, used: false };

	// Normalize line endings up front: split on CRLF / lone CR / LF so every downstream regex sees a
	// clean line (a trailing `\r` would defeat the `$`-anchored fence + marker patterns). The join is
	// always LF — mdsvex is line-ending agnostic, so canonicalizing here costs nothing.
	const lines = src.split(LINE_BREAK_RE);
	const out: string[] = [];
	let top_fence: Fence | null = null; // a fence at the TOP level — pass its lines through untouched
	let auto = 0; // per-block group counter for `::: tabs`
	let used = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Inside a top-level code fence: pass through, watching only for its close. A `::: code-group`
		// written inside a sample is therefore left alone.
		if (top_fence) {
			if (fence_close(line, top_fence)) top_fence = null;
			out.push(line);
			continue;
		}
		const opener = fence_open(line);
		if (opener) {
			top_fence = opener.fence;
			out.push(line);
			continue;
		}

		const code_open = OPEN_CODE.exec(line);
		const tabs_open = code_open ? null : OPEN_TABS.exec(line);
		if (!code_open && !tabs_open) {
			out.push(line);
			continue;
		}

		// Collect the block body up to its matching `:::` close — FENCE-AWARE, so a `:::` sitting inside
		// an inner code fence doesn't end the block early. `end` lands on the close line, or EOF.
		const { body, end } = collect_block(lines, i + 1);

		const tabs = code_open ? parse_code_group(body) : parse_tabs(body);
		if (tabs.length) {
			used = true;
			const named = (code_open?.[1] ?? tabs_open?.[1] ?? '').trim();
			const group = named || (code_open ? group_key(tabs) : `tabs${auto++}`);
			emit(out, group, tabs);
		}
		i = end; // resume after the close line (or at EOF)
	}

	return { code: out.join('\n'), used };
}

/** Gather lines until the block's own `:::` close, tracking inner fences so a fenced `:::` is skipped. */
function collect_block(lines: string[], start: number): { body: string[]; end: number } {
	const body: string[] = [];
	let fence: Fence | null = null;
	let i = start;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (fence) {
			if (fence_close(line, fence)) fence = null;
			body.push(line);
			continue;
		}
		const opener = fence_open(line);
		if (opener) {
			fence = opener.fence;
			body.push(line);
			continue;
		}
		if (CLOSE.test(line)) return { body, end: i };
		body.push(line);
	}
	return { body, end: lines.length }; // unclosed block: tolerate, run to EOF
}

type ParsedTab = { label: string; body: string[] };

/** A stable group key from a code-group's labels (identical label sets sync across the page). */
function group_key(tabs: ParsedTab[]): string {
	return 'cg:' + tabs.map((t) => t.label).join('~');
}

/** Pull the `[label]` out of a fence info string; return the label (or null) and the leftover language. */
function split_label(info: string): { label: string | null; lang: string } {
	const m = BRACKET_LABEL_RE.exec(info);
	if (!m) return { label: null, lang: info.trim() };
	const label = m[1].trim();
	const lang = (info.slice(0, m.index) + info.slice(m.index + m[0].length)).trim();
	return { label: label || null, lang };
}

/** One tab per fenced block; label from the fence's `[label]`. Handles fence length + missing labels. */
function parse_code_group(body: string[]): ParsedTab[] {
	const tabs: ParsedTab[] = [];
	let fence: Fence | null = null;
	let cur: ParsedTab | null = null;
	let n = 0;
	for (const line of body) {
		if (fence) {
			if (fence_close(line, fence)) {
				fence = null;
				if (cur) cur.body.push(line);
			} else if (cur) {
				cur.body.push(line);
			}
			continue;
		}
		const opener = fence_open(line);
		if (opener) {
			fence = opener.fence;
			const { label, lang } = split_label(opener.info);
			cur = {
				label: label ?? `Tab ${n + 1}`,
				body: [`${opener.indent}${opener.fence.char.repeat(opener.fence.len)}${lang}`]
			};
			tabs.push(cur);
			n += 1;
			continue;
		}
		// Non-fence lines between code blocks are ignored (code-group holds only code).
	}
	// An unclosed fence at the block's end: synthesize a closer so the emitted markdown stays
	// well-formed (an open fence would otherwise swallow the `</Tab>` wrapper as code text).
	if (fence && cur) cur.body.push(fence.char.repeat(fence.len));
	return tabs;
}

/** One tab per `== Label`; fence-aware, so a `== …` line inside a code sample isn't a marker. */
function parse_tabs(body: string[]): ParsedTab[] {
	const tabs: ParsedTab[] = [];
	let fence: Fence | null = null;
	let cur: ParsedTab | null = null;
	for (const line of body) {
		if (fence) {
			if (fence_close(line, fence)) fence = null;
			if (cur) cur.body.push(line);
			continue;
		}
		const opener = fence_open(line);
		if (opener) {
			fence = opener.fence;
			if (cur) cur.body.push(line);
			continue;
		}
		const mark = TAB_MARK.exec(line);
		if (mark) {
			cur = { label: mark[1], body: [] };
			tabs.push(cur);
			continue;
		}
		if (cur) cur.body.push(line); // content before the first `==` is dropped
	}
	// Close a fence left open at the block's end, mirroring `parse_code_group` — keep the tab body's
	// markdown well-formed rather than leaking an unterminated fence into mdsvex.
	if (fence && cur) cur.body.push(fence.char.repeat(fence.len));
	return tabs;
}

/** Write the `<TabGroup>`/`<Tab>` block, with blank lines so mdsvex renders the markdown inside. */
function emit(out: string[], group: string, tabs: ParsedTab[]): void {
	// No `labels` prop: the island reads each label from the frozen panel's own `data-label` (set by
	// `<Tab label>`), so nothing needs to cross as a separate serializable list.
	out.push('', `<TabGroup group="${attr(group)}">`, '');
	for (const t of tabs) {
		out.push(`<Tab label="${attr(t.label)}">`, '', ...trim_blanks(t.body), '', '</Tab>');
	}
	out.push('', '</TabGroup>', '');
}

/** Drop leading/trailing blank lines from a tab body (keeps the emitted block tight). */
function trim_blanks(body: string[]): string[] {
	let s = 0;
	let e = body.length;
	while (s < e && body[s].trim() === '') s++;
	while (e > s && body[e - 1].trim() === '') e--;
	return body.slice(s, e);
}
