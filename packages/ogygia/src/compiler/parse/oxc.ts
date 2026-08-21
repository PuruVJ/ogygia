/**
 * The one parser the `import.meta.og.*` transforms use. It must (a) parse TypeScript — the constructs
 * live in `.ts`/`.svelte.ts` and `<script lang="ts">` — and (b) preserve BYTE OFFSETS against the
 * original source, because every transform splices by span. That rules out `parseAst` (rollup's
 * parser: no TS) and type-stripping (shifts offsets).
 *
 * The parser comes straight from `rolldown` (ogygia's own dependency, not `vite`'s export), so the
 * construct family works the same on any supported Vite (7's rollup or 8's rolldown); a Vite-7 app
 * just also carries rolldown for this. The TS-capable oxc parser lives under `rolldown/utils` — NOT a
 * shaky choice: `rolldown/parseAst` is the rollup-compat parser (throws on TS), and Vite's own
 * `parseSync` is this same oxc parser re-exported. One import, one decision.
 */
import { parseSync } from 'rolldown/utils';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

export type Comment = { start: number; end: number };
export type ParseResult = { program: Node | null; ok: boolean; comments: Comment[] };

/**
 * Parse `code` (named by `id`, whose extension picks the dialect) to an oxc/ESTree program. Never
 * throws: a syntax error (or a half-typed file mid-edit) yields `{ program: null, ok: false }`, and
 * callers fall back (scanner) or skip. Offsets on the returned nodes are exact against `code`.
 * `comments` carries trivia (block/line) with byte offsets — not present in the AST body.
 */
export function parse_module(code: string, id: string): ParseResult {
	try {
		const result = parseSync(id, code) as {
			program?: Node;
			errors?: unknown[];
			comments?: Comment[];
		};
		if (result.errors && result.errors.length > 0)
			return { program: null, ok: false, comments: [] };
		return {
			program: result.program ?? null,
			ok: !!result.program,
			comments: result.comments ?? []
		};
	} catch {
		return { program: null, ok: false, comments: [] };
	}
}
