/**
 * Flag/experiment INVENTORY — pure OBSERVATION during the prescan. Nothing is rewritten, so per
 * the macro law this is deliberately NOT an `import.meta.og.*` construct: the compiler only
 * REPORTS what it saw. The build writes the collected sites to
 * `node_modules/.ogygia/flags-manifest.json` — diff it in CI to catch flags that never die
 * (flag debt: the reason Uber built a whole refactoring bot; an inventory is the law-abiding
 * subset our file-local compiler can give for free).
 *
 * AST-walked, not text-matched (user ruling): `flag` is an ordinary function — a text sweep
 * would miss `import { flag as f }` and false-positive on any local function that happens to be
 * named `flag`. The walk resolves the module's ACTUAL bindings from `'ogygia/flag'` (named, renamed,
 * or namespace imports) and only counts calls through those. Known pragmatic limit (same as the
 * macro family's): a local declaration SHADOWING an imported `flag` inside a nested scope is not
 * scope-analyzed.
 */
import { walk } from 'estree-walker';
import { parse_module } from './parse/oxc.js';

export interface FlagSite {
	name: string;
	kind: 'flag';
	/** root-relative (or package-relative) posix path. */
	file: string;
	line: number;
}

type AstNode = {
	type: string;
	start?: number;
	end?: number;
	[k: string]: unknown;
};

const KINDS = new Set(['flag']);
/** Cheap pre-parse gate — most modules import ogygia for other reasons. */
const MAYBE_RE = /\bflag\b/;
/** All `<script …>` blocks of a `.svelte` file (instance AND module — flags can sit in either). */
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
const NL = 10;

function line_at(src: string, index: number, base_line: number): number {
	let line = base_line;
	for (let i = 0; i < index; i++) if (src.charCodeAt(i) === NL) line++;
	return line;
}

function string_arg(node: AstNode | undefined): string | null {
	if (!node) return null;
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value as string;
	return null;
}

/** Walk ONE parsed js/ts body. `base_line` positions a svelte script block inside its file. */
function collect_from_source(
	src: string,
	id: string,
	file: string,
	base_line: number,
	out: FlagSite[]
): void {
	const result = parse_module(src, id);
	if (!result.ok || !result.program) return;

	// 1) resolve this module's REAL bindings from 'ogygia/flag': local name → kind, plus namespaces
	const locals = new Map<string, FlagSite['kind']>();
	const namespaces = new Set<string>();
	for (const node of ((result.program as AstNode).body as AstNode[]) ?? []) {
		if (node.type !== 'ImportDeclaration') continue;
		if ((node.source as AstNode | undefined)?.value !== 'ogygia/flag') continue;
		for (const s of (node.specifiers as AstNode[]) ?? []) {
			if (s.type === 'ImportSpecifier') {
				const imported = (s.imported as AstNode)?.name as string;
				if (KINDS.has(imported))
					locals.set((s.local as AstNode).name as string, imported as FlagSite['kind']);
			} else if (s.type === 'ImportNamespaceSpecifier') {
				namespaces.add((s.local as AstNode).name as string);
			}
		}
	}
	if (locals.size === 0 && namespaces.size === 0) return;

	// 2) count only calls through those bindings
	walk(result.program as never, {
		enter(n: unknown) {
			const node = n as AstNode;
			if (node.type !== 'CallExpression') return;
			const callee = node.callee as AstNode;
			let kind: FlagSite['kind'] | undefined;
			if (callee?.type === 'Identifier') {
				kind = locals.get(callee.name as string);
			} else if (
				callee?.type === 'MemberExpression' &&
				(callee.object as AstNode)?.type === 'Identifier' &&
				namespaces.has((callee.object as AstNode).name as string) &&
				callee.computed !== true &&
				KINDS.has((callee.property as AstNode)?.name as string)
			) {
				kind = (callee.property as AstNode).name as FlagSite['kind'];
			}
			if (!kind) return;
			const name = string_arg((node.arguments as AstNode[])?.[0]);
			if (name == null) return; // dynamic first arg — not inventoriable (and not our style)
			out.push({ name, kind, file, line: line_at(src, node.start ?? 0, base_line) });
		}
	});
}

export function collect_flag_sites(code: string, id: string, file: string): FlagSite[] {
	if (!code.includes('ogygia') || !MAYBE_RE.test(code)) return [];
	const out: FlagSite[] = [];
	if (id.endsWith('.svelte')) {
		SCRIPT_BLOCK_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = SCRIPT_BLOCK_RE.exec(code))) {
			const body_start = m.index + m[0].indexOf('>') + 1;
			collect_from_source(m[1], id + '.ts', file, line_at(code, body_start, 1), out);
		}
	} else {
		collect_from_source(code, id, file, 1, out);
	}
	return out;
}

/** Stable, deduped (both build legs prescan) manifest shape. */
export function flags_manifest(sites: readonly FlagSite[]): {
	flags: FlagSite[];
	names: string[];
} {
	const seen = new Set<string>();
	const flags: FlagSite[] = [];
	for (const s of sites) {
		const k = `${s.kind}\0${s.name}\0${s.file}\0${s.line}`;
		if (seen.has(k)) continue;
		seen.add(k);
		flags.push(s);
	}
	flags.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : 1));
	return { flags, names: [...new Set(flags.map((f) => f.name))].sort() };
}
