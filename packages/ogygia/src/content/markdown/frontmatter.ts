/**
 * ogygia's frontmatter module — a dependency-free parser (no `yaml` npm package), used both by our
 * own `parseFrontmatter` split and directly by mdsvex (wired via its `frontmatter.parse` option) so
 * ALL content frontmatter goes through one code path.
 *
 * It is a FRONTMATTER parser first and a YAML parser second: it does not chase full YAML flow
 * semantics. A brace-wrapped value with no top-level colon (`title: {@const}`, `{#each ...}`) stays
 * the STRING it looks like, not a `{ '@const': null }` mapping — the shape the Svelte docs use.
 *
 * `parse_yaml` takes the text BETWEEN the `---` fences and returns a plain JS value — almost always a
 * `Record<string, unknown>`, but a top-level sequence or scalar is also valid. An empty /
 * whitespace-only source returns `{}` (NOT null).
 *
 * ---------------------------------------------------------------------------
 * SUPPORTED SUBSET (this is a frontmatter parser, not a full YAML engine)
 * ---------------------------------------------------------------------------
 * - Block mappings via indentation nesting (any consistent indent width).
 * - Block sequences: `- item` lines, sequences of maps (`- key: val` + indented
 *   siblings), and nested sequences (`- - x`).
 * - Scalars:
 *     - plain (unquoted) strings
 *     - single-quoted (literal; `''` escapes one quote)
 *     - double-quoted (escapes: \n \t \r \0 \" \\ \/ \b \f \uXXXX)
 * - Typed plain scalars: integers, floats (negative, leading `+`, exponent,
 *   `.5`, `.inf`, `.nan`, hex `0x`, octal `0o`), `true`/`false`, null.
 * - Flow collections on one line: `[a, b, c]` and `{ a: 1, b: two }` (may nest).
 * - Comments: `#` to end of line, but NOT inside quotes or flow scalars, and
 *   only when preceded by whitespace / start-of-line (so `a#b` stays plain).
 * - Block scalars: `|` (literal) and `>` (folded), with indentation stripping.
 *   Chomping / indent indicators (`|-`, `|+`, `>-`, `>2`, ...) are supported.
 * - Quoted KEYS as well as quoted values.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATE OMISSIONS / DIFFERENCES FROM THE `yaml` PACKAGE
 * ---------------------------------------------------------------------------
 * - The "Norway problem": ONLY `true`/`false` (and their `True`/`TRUE` casings)
 *   are booleans. `yes`/`no`/`on`/`off`/`y`/`n` stay STRINGS. This is a
 *   deliberate divergence to avoid `country: no` becoming `false`.
 * - Dates / timestamps are NOT auto-converted to `Date`. ISO date strings stay
 *   STRINGS. The caller's schema layer coerces them if it wants a `Date`.
 * - NOT supported (ignored / treated as plain text): anchors & aliases
 *   (`&`/`*`), tags (`!!`), multi-document `---` separators inside the block,
 *   complex / explicit keys (`? ...`), and merge keys (`<<`).
 *
 * @module
 */

type Ctx = { lines: string[]; i: number };
type Cursor = { s: string; i: number };

/** Count leading spaces; throw if a tab is used for indentation. */
function indent_of(line: string): number {
	let i = 0;
	while (i < line.length && line[i] === ' ') i++;
	if (line[i] === '\t') {
		throw new Error('[ogygia/yaml] tabs are not allowed for indentation');
	}
	return i;
}

/** Leading-space count without the tab guard (used for raw block-scalar lines). */
function leading_spaces(line: string): number {
	let i = 0;
	while (i < line.length && line[i] === ' ') i++;
	return i;
}

/** A line that carries no structure: blank, or a full-line `#` comment. */
function is_skippable(line: string): boolean {
	const t = line.trim();
	return t === '' || t[0] === '#';
}

function skip_blank_comments(ctx: Ctx): void {
	while (ctx.i < ctx.lines.length && is_skippable(ctx.lines[ctx.i])) ctx.i++;
}

/** `- ` sequence entry (dash followed by a space or end-of-line). */
function is_seq_item(content: string): boolean {
	return content === '-' || content.startsWith('- ') || content.startsWith('-\t');
}

/**
 * Find the `:` that separates a block-mapping key from its value: the first
 * top-level colon followed by whitespace or end-of-line, skipping quotes and
 * flow brackets. Returns -1 when the line is not a mapping entry.
 */
function find_key_colon(s: string): number {
	let in_s = false;
	let in_d = false;
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (in_s) {
			if (c === "'") {
				if (s[i + 1] === "'") i++;
				else in_s = false;
			}
			continue;
		}
		if (in_d) {
			if (c === '\\') i++;
			else if (c === '"') in_d = false;
			continue;
		}
		if (c === '"') in_d = true;
		else if (c === "'") in_s = true;
		else if (c === '[' || c === '{') depth++;
		else if (c === ']' || c === '}') depth--;
		else if (c === ':' && depth === 0) {
			const n = s[i + 1];
			if (n === undefined || n === ' ' || n === '\t') return i;
		}
	}
	return -1;
}

/**
 * Strip a trailing `# comment` from a single-line value, honouring quotes and
 * flow brackets, and only treating `#` as a comment when it is preceded by
 * whitespace (or starts the string).
 */
function strip_comment(s: string): string {
	let in_s = false;
	let in_d = false;
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (in_s) {
			if (c === "'") {
				if (s[i + 1] === "'") i++;
				else in_s = false;
			}
			continue;
		}
		if (in_d) {
			if (c === '\\') i++;
			else if (c === '"') in_d = false;
			continue;
		}
		if (c === '"') in_d = true;
		else if (c === "'") in_s = true;
		else if (c === '[' || c === '{') depth++;
		else if (c === ']' || c === '}') depth--;
		else if (c === '#' && depth === 0 && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
			return s.slice(0, i);
		}
	}
	return s;
}

/** Read a `"..."` scalar starting at `i` (which points at the opening quote). */
function read_double_quoted(s: string, i: number): { value: string; i: number } {
	i++;
	let out = '';
	while (i < s.length) {
		const c = s[i];
		if (c === '\\') {
			const n = s[i + 1];
			switch (n) {
				case 'n':
					out += '\n';
					break;
				case 't':
					out += '\t';
					break;
				case 'r':
					out += '\r';
					break;
				case '0':
					out += '\0';
					break;
				case 'b':
					out += '\b';
					break;
				case 'f':
					out += '\f';
					break;
				case '"':
					out += '"';
					break;
				case '\\':
					out += '\\';
					break;
				case '/':
					out += '/';
					break;
				case 'u': {
					const hex = s.slice(i + 2, i + 6);
					if (/^[0-9a-fA-F]{4}$/.test(hex)) {
						out += String.fromCharCode(parseInt(hex, 16));
						i += 6;
						continue;
					}
					out += 'u';
					break;
				}
				default:
					out += n ?? '';
			}
			i += 2;
			continue;
		}
		if (c === '"') return { value: out, i: i + 1 };
		out += c;
		i++;
	}
	return { value: out, i };
}

/** Read a `'...'` scalar starting at `i`; `''` yields a single quote. */
function read_single_quoted(s: string, i: number): { value: string; i: number } {
	i++;
	let out = '';
	while (i < s.length) {
		const c = s[i];
		if (c === "'") {
			if (s[i + 1] === "'") {
				out += "'";
				i += 2;
				continue;
			}
			return { value: out, i: i + 1 };
		}
		out += c;
		i++;
	}
	return { value: out, i };
}

/** Coerce a plain (unquoted) scalar to its typed JS value. */
function parse_plain(text: string): unknown {
	if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
	if (text === 'true' || text === 'True' || text === 'TRUE') return true;
	if (text === 'false' || text === 'False' || text === 'FALSE') return false;

	if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text[0] === '-' ? -Infinity : Infinity;
	if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN;

	if (/^[-+]?0x[0-9a-fA-F]+$/.test(text)) {
		const neg = text[0] === '-';
		const n = Number(text.replace(/^[-+]/, ''));
		return neg ? -n : n;
	}
	if (/^[-+]?0o[0-7]+$/.test(text)) {
		const neg = text[0] === '-';
		const n = parseInt(text.replace(/^[-+]?0o/, ''), 8);
		return neg ? -n : n;
	}
	if (/^[-+]?[0-9]+$/.test(text)) return parseInt(text, 10);
	if (
		/^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*|[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(text) &&
		/[.eE]/.test(text)
	) {
		return Number(text);
	}
	return text;
}

function skip_ws(p: Cursor): void {
	while (p.i < p.s.length && (p.s[p.i] === ' ' || p.s[p.i] === '\t')) p.i++;
}

/** Read a plain flow token up to a `,`/`]`/`}` (and `:` when reading a key). */
function read_flow_plain(p: Cursor, is_key: boolean): string {
	const start = p.i;
	while (p.i < p.s.length) {
		const c = p.s[p.i];
		if (c === ',' || c === ']' || c === '}') break;
		if (is_key && c === ':') break;
		p.i++;
	}
	return p.s.slice(start, p.i).trim();
}

function read_flow_node(p: Cursor): unknown {
	skip_ws(p);
	const c = p.s[p.i];
	if (c === '[') return read_flow_seq(p);
	if (c === '{') return read_flow_map(p);
	if (c === '"') {
		const r = read_double_quoted(p.s, p.i);
		p.i = r.i;
		return r.value;
	}
	if (c === "'") {
		const r = read_single_quoted(p.s, p.i);
		p.i = r.i;
		return r.value;
	}
	const raw = read_flow_plain(p, false);
	return raw === '' ? null : parse_plain(raw);
}

function read_flow_seq(p: Cursor): unknown[] {
	p.i++; // consume '['
	const arr: unknown[] = [];
	skip_ws(p);
	if (p.s[p.i] === ']') {
		p.i++;
		return arr;
	}
	while (p.i < p.s.length) {
		arr.push(read_flow_node(p));
		skip_ws(p);
		const c = p.s[p.i];
		if (c === ',') {
			p.i++;
			skip_ws(p);
			if (p.s[p.i] === ']') {
				p.i++;
				return arr;
			}
			continue;
		}
		if (c === ']') {
			p.i++;
			return arr;
		}
		break;
	}
	return arr;
}

function read_flow_map(p: Cursor): Record<string, unknown> {
	p.i++; // consume '{'
	const obj: Record<string, unknown> = {};
	skip_ws(p);
	if (p.s[p.i] === '}') {
		p.i++;
		return obj;
	}
	while (p.i < p.s.length) {
		skip_ws(p);
		let key: string;
		const kc = p.s[p.i];
		if (kc === '"') {
			const r = read_double_quoted(p.s, p.i);
			p.i = r.i;
			key = r.value;
		} else if (kc === "'") {
			const r = read_single_quoted(p.s, p.i);
			p.i = r.i;
			key = r.value;
		} else {
			key = read_flow_plain(p, true);
		}
		skip_ws(p);
		if (p.s[p.i] === ':') p.i++;
		const value = read_flow_node(p);
		obj[key] = value;
		skip_ws(p);
		const c = p.s[p.i];
		if (c === ',') {
			p.i++;
			skip_ws(p);
			if (p.s[p.i] === '}') {
				p.i++;
				return obj;
			}
			continue;
		}
		if (c === '}') {
			p.i++;
			return obj;
		}
		break;
	}
	return obj;
}

function parse_flow(text: string): unknown {
	const p: Cursor = { s: text, i: 0 };
	return read_flow_node(p);
}

/** True if a `{…}` is really a mapping — empty (`{}`), or holding a top-level (`depth === 1`) `:` —
 *  as opposed to a brace-wrapped token like `{@const}`. Quotes are skipped. */
/** A `{…}` is a real mapping only if it's empty or holds a top-level (`depth === 1`) `:`; a `[…]` is
 *  a real sequence only if it's empty or holds a top-level `,`. Otherwise the brace/bracket value is
 *  a plain string (`title: {@const}` / `title: [create your own]`) — frontmatter is text first. */
function is_flow_collection(text: string, open: '{' | '[', sep: ':' | ','): boolean {
	const close = open === '{' ? '}' : ']';
	if (text.slice(text.indexOf(open) + 1, text.lastIndexOf(close)).trim() === '') return true;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'") {
			const q = ch;
			for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++;
			continue;
		}
		if (ch === '{' || ch === '[') depth++;
		else if (ch === '}' || ch === ']') depth--;
		else if (ch === sep && depth === 1) return true;
	}
	return false;
}

/** A single-line value: quoted, flow, or a typed plain scalar. Empty → null. */
function parse_scalar(text: string): unknown {
	if (text === '') return null;
	const c = text[0];
	// Frontmatter is TEXT first; we don't chase full YAML flow semantics. `{…}` / `[…]` values are only
	// real collections when they actually hold pairs / multiple items — svelte docs title pages with
	// `{@const}`, `{#if ...}`, or `[create your own]`, which look like flow but are just the STRING.
	if (c === '{') return is_flow_collection(text, '{', ':') ? parse_flow(text) : text;
	if (c === '[') return is_flow_collection(text, '[', ',') ? parse_flow(text) : text;
	if (c === '"') return read_double_quoted(text, 0).value;
	if (c === "'") return read_single_quoted(text, 0).value;
	return parse_plain(text);
}

/** A `key` token (may be quoted). Keys are always strings for frontmatter. */
function parse_key(raw: string): string {
	const t = raw.trim();
	if (t[0] === '"') return read_double_quoted(t, 0).value;
	if (t[0] === "'") return read_single_quoted(t, 0).value;
	return t;
}

function is_block_scalar_indicator(s: string): boolean {
	if (s[0] !== '|' && s[0] !== '>') return false;
	const rest = s.slice(1);
	return /^[+-]?[0-9]*$/.test(rest) || /^[0-9]*[+-]?$/.test(rest);
}

/**
 * Parse a `|` (literal) or `>` (folded) block scalar. The key/indicator line
 * has already been consumed; `parent_indent` is the column of that key (content
 * must be indented deeper than it).
 */
function parse_block_scalar(ctx: Ctx, parent_indent: number, header: string): string {
	const style = header[0];
	let chomp = '';
	let explicit = 0;
	for (const ch of header.slice(1)) {
		if (ch === '+' || ch === '-') chomp = ch;
		else if (ch >= '0' && ch <= '9') explicit = explicit * 10 + (ch.charCodeAt(0) - 48);
	}

	const collected: string[] = [];
	while (ctx.i < ctx.lines.length) {
		const l = ctx.lines[ctx.i];
		if (l.trim() === '') {
			collected.push('');
			ctx.i++;
			continue;
		}
		if (leading_spaces(l) <= parent_indent) break;
		collected.push(l);
		ctx.i++;
	}

	let content_indent: number;
	if (explicit > 0) {
		content_indent = parent_indent + explicit;
	} else {
		content_indent = Infinity;
		for (const l of collected) {
			if (l.trim() !== '') content_indent = Math.min(content_indent, leading_spaces(l));
		}
		if (content_indent === Infinity) content_indent = parent_indent + 1;
	}

	const stripped = collected.map((l) => (l.trim() === '' ? '' : l.slice(content_indent)));

	let end = stripped.length;
	while (end > 0 && stripped[end - 1] === '') end--;
	const body = stripped.slice(0, end);
	const trailing_blanks = stripped.length - end;

	let text: string;
	if (style === '|') {
		text = body.join('\n');
	} else {
		// Folded: a line break between two non-empty lines folds to a space; each
		// blank line becomes a newline (and absorbs the surrounding fold).
		text = '';
		for (let k = 0; k < body.length; k++) {
			const cur = body[k];
			if (k === 0) text += cur;
			else if (cur === '') text += '\n';
			else if (body[k - 1] === '') text += cur;
			else text += ' ' + cur;
		}
	}

	if (body.length === 0) return chomp === '+' ? '\n'.repeat(trailing_blanks) : '';
	if (chomp === '-') return text;
	if (chomp === '+') return text + '\n'.repeat(trailing_blanks + 1);
	return text + '\n';
}

/**
 * Value that follows a `key:` (or `-`) with nothing on the same line: a nested
 * block indented deeper, a sequence at the same column, or null.
 */
function parse_child(ctx: Ctx, indent: number): unknown {
	const save = ctx.i;
	skip_blank_comments(ctx);
	if (ctx.i >= ctx.lines.length) {
		ctx.i = save;
		return null;
	}
	const line = ctx.lines[ctx.i];
	const col = indent_of(line);
	const content = line.slice(col);
	if (col > indent) return parse_block(ctx, col);
	if (col === indent && is_seq_item(content)) return parse_sequence(ctx, indent);
	ctx.i = save;
	return null;
}

function parse_sequence(ctx: Ctx, indent: number): unknown[] {
	const arr: unknown[] = [];
	while (true) {
		skip_blank_comments(ctx);
		if (ctx.i >= ctx.lines.length) break;
		const line = ctx.lines[ctx.i];
		const col = indent_of(line);
		if (col !== indent) break;
		const content = line.slice(col);
		if (!is_seq_item(content)) break;

		const rest = content.slice(1);
		if (rest.trim() === '') {
			ctx.i++;
			const save = ctx.i;
			skip_blank_comments(ctx);
			if (ctx.i < ctx.lines.length && indent_of(ctx.lines[ctx.i]) > col) {
				arr.push(parse_block(ctx, indent_of(ctx.lines[ctx.i])));
			} else {
				ctx.i = save;
				arr.push(null);
			}
		} else {
			const leading = rest.length - rest.replace(/^ */, '').length;
			const item_indent = col + 1 + leading;
			// Blank the dash so the inline content keeps its column, then reparse.
			ctx.lines[ctx.i] = ' '.repeat(col + 1) + rest;
			arr.push(parse_block(ctx, item_indent));
		}
	}
	return arr;
}

function parse_mapping(ctx: Ctx, indent: number): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	while (true) {
		skip_blank_comments(ctx);
		if (ctx.i >= ctx.lines.length) break;
		const line = ctx.lines[ctx.i];
		const col = indent_of(line);
		if (col !== indent) break;
		const content = line.slice(col);
		if (is_seq_item(content)) break;
		const kc = find_key_colon(content);
		if (kc === -1) break;

		const key = parse_key(content.slice(0, kc));
			// An empty key (a line that is just `:` or `: : :`) is malformed, not a valid mapping —
			// surface it so callers reject broken frontmatter instead of silently keying on "".
			if (key === '') {
				throw new Error(`[ogygia/yaml] empty mapping key in line: ${JSON.stringify(line.trim())}`);
			}
		const value_part = content.slice(kc + 1);
		ctx.i++;
		const clean = strip_comment(value_part).trim();

		if (is_block_scalar_indicator(clean)) {
			obj[key] = parse_block_scalar(ctx, indent, clean);
		} else if (clean === '') {
			obj[key] = parse_child(ctx, indent);
		} else {
			obj[key] = parse_scalar(clean);
		}
	}
	return obj;
}

/** Dispatch a block node at column `indent`: sequence, mapping, or scalar. */
function parse_block(ctx: Ctx, indent: number): unknown {
	skip_blank_comments(ctx);
	const line = ctx.lines[ctx.i];
	const col = indent_of(line);
	const content = line.slice(col);
	if (is_seq_item(content)) return parse_sequence(ctx, indent);
	if (find_key_colon(content) !== -1) return parse_mapping(ctx, indent);

	ctx.i++;
	const clean = strip_comment(content).trim();
	if (is_block_scalar_indicator(clean)) return parse_block_scalar(ctx, indent - 1, clean);
	return parse_scalar(clean);
}

/**
 * Parse a YAML frontmatter block (the text BETWEEN the `---` fences) into a
 * plain JS value. Empty / whitespace-only input returns `{}` (an empty object),
 * never null.
 */
export function parse_yaml(source: string): unknown {
	const normalized = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
	const ctx: Ctx = { lines: normalized.split('\n'), i: 0 };
	skip_blank_comments(ctx);
	if (ctx.i >= ctx.lines.length) return {};
	const base = indent_of(ctx.lines[ctx.i]);
	const result = parse_block(ctx, base);
	return result === undefined ? {} : result;
}


const BOM = /^\uFEFF/;
const LEADING_NEWLINE = /^\r?\n/;

export type FrontmatterResult = {
	data: Record<string, unknown>;
	body: string;
};

/**
 * Minimal `---` YAML frontmatter split. Body is unused for glob catalogs
 * (Content comes from the Vite module); data is schema-validated.
 */
export function parseFrontmatter(source: string): FrontmatterResult {
	const text = source.replace(BOM, '');
	if (!text.startsWith('---')) {
		return { data: {}, body: text };
	}
	const lineEnd = text.indexOf('\n');
	if (lineEnd === -1) return { data: {}, body: text };
	const close = text.indexOf('\n---', lineEnd);
	if (close === -1) return { data: {}, body: text };
	const yamlBlock = text.slice(lineEnd + 1, close);
	const after = text.slice(close + 4).replace(LEADING_NEWLINE, '');
	let data: Record<string, unknown> = {};
	try {
		const parsed = parse_yaml(yamlBlock);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			data = parsed as Record<string, unknown>;
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`[ogygia/content] invalid frontmatter YAML: ${msg}`);
	}
	return { data, body: after };
}
