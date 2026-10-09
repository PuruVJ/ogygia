/**
 * The one parser the `import.meta.og.*` transforms use. It must (a) parse TypeScript — the constructs
 * live in `.ts`/`.svelte.ts` and `<script lang="ts">` — and (b) preserve BYTE OFFSETS against the
 * original source, because every transform splices by span. That rules out `parseAst` (rollup's
 * parser: no TS) and type-stripping (shifts offsets).
 *
 * The parser comes from the app's required `vite` peer: Vite 8 re-exports the TS-capable oxc parser
 * as `parseSync` (byte-identical to `rolldown/utils`' — verified), so ogygia carries no `rolldown`
 * dependency of its own for this. NOT a shaky choice: `parseAst` is the rollup-compat parser (throws
 * on TS); `parseSync` is the oxc parser. One import, one decision.
 */
import { createRequire } from 'node:module';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

export type Comment = { start: number; end: number };
export type ParseResult = { program: Node | null; ok: boolean; comments: Comment[] };

/** The raw oxc parse signature (`(id, code) → { program, errors, comments }`). */
export type RawParse = (
	id: string,
	code: string
) => { program?: Node; errors?: unknown[]; comments?: Comment[] };

/**
 * The parser is INJECTABLE so the SAME oxc can run in the browser (the Observatory / Rung 1). Node
 * uses the default `rolldown/utils` (native); a browser build installs `@rolldown/browser/utils`
 * (WASM, the SAME rolldown version → byte-identical AST) via {@link set_parser}, after awaiting the
 * WASM init. This is the seam, not a parser swap for Node: the default below is unchanged, so the
 * production build parses exactly as before. (bake() keeps rolldown too, so this is consistency —
 * same parser both realms — not a new dependency.)
 */
// Node's default parser is loaded LAZILY (first use), NOT statically imported, so a BROWSER build of
// this module (the Observatory / Rung 1) never eagerly pulls the native `rolldown/utils` binding: the
// browser installs the WASM parser via set_parser() before the first parse, so this default is never
// reached there. Node hits it on the first parse and memoizes parseSync. (A static
// `import { parseSync } from 'rolldown/utils'` made Vite's dev dep-optimizer load the native binding
// inside the Observatory's browser worker → an opaque module-load crash; the production build tree-shook
// past it, so only `dev` was affected. Lazy-loading fixes dev without touching the Node parse path.)
let node_parse_sync: RawParse | undefined;
function node_default_parse(id: string, code: string) {
	if (!node_parse_sync) {
		const require = createRequire(import.meta.url);
		// Vite re-exports the SAME oxc parser as `rolldown/utils` (byte-identical AST — verified), so
		// this reads through the app's required `vite` peer instead of a direct `rolldown` dependency.
		// The browser realm still installs the WASM oxc parser via `set_parser()` (below), unchanged;
		// a VARIABLE specifier keeps any bundler from statically pulling Node-only `vite` into the
		// browser Observatory worker (this default is never reached there — the WASM parser is set).
		const vite_spec = 'vite';
		node_parse_sync = (require(vite_spec) as { parseSync: RawParse }).parseSync;
	}
	return node_parse_sync(id, code);
}

let raw_parse: RawParse = node_default_parse;

/** Install a browser (or test) parser with the same call shape. No-arg reset restores the default. */
export function set_parser(fn?: RawParse): void {
	raw_parse = fn ?? node_default_parse;
}

/**
 * Parse `code` (named by `id`, whose extension picks the dialect) to an oxc/ESTree program. Never
 * throws: a syntax error (or a half-typed file mid-edit) yields `{ program: null, ok: false }`, and
 * callers fall back (scanner) or skip. Offsets on the returned nodes are exact against `code`.
 * `comments` carries trivia (block/line) with byte offsets — not present in the AST body.
 */
export function parse_module(code: string, id: string): ParseResult {
	try {
		const result = raw_parse(id, code) as {
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
