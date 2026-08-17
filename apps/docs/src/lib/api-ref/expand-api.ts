/**
 * `> MODULE: ogygia/content` — the docs' auto-generated API reference, as a remark plugin (the same
 * directive shape svelte-dev's expand-types uses). Wired `{ enforce: 'pre', plugin: expandApi }` so
 * the generated headings/fences flow through ogygia's built-in passes (TOC, anchors, code ids, the
 * link audit) exactly as if hand-authored. The markdown comes from the package's own rolled-up
 * `dist/*.d.ts` (see extract.ts) and is parsed back to mdast to splice in place of the blockquote.
 *
 * Auto-regeneration is contract-backed, not hoped-for: `expandApiCacheKey` (the d.ts mtime stamp)
 * rides the pipeline's doc-cache signature, and `expandApiDependencies` hands Vite the d.ts files
 * each page actually read, so a `build:lib` in dev recompiles exactly the affected pages.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { extractModule, distStampCached } from './extract.ts';
import { renderModule } from './render.ts';

type Node = { type: string; value?: string; children?: Node[] };

/**
 * Make the generated mdast svelte-safe. Spliced trees BYPASS mdsvex's parse-time escaping, and its
 * serializer passes text through raw (markdown braces as svelte expressions is an mdsvex feature) —
 * so JSDoc prose containing `{…}` or `<tag` would compile as template syntax. Escape at the NODE
 * level, which is exact where line-regex games are not: text values get entity braces/angles;
 * inline code carrying svelte-meaningful chars becomes a raw entity-escaped `<code>`; fenced code
 * stays untouched (its escaping happens at serialize time in the highlighter).
 */
function svelteSafe(node: Node): void {
	if (node.type === 'code') return; // fence — highlighter owns it
	if (node.type === 'inlineCode' && typeof node.value === 'string') {
		if (/[{}<>]/.test(node.value)) {
			const ent = node.value
				.replaceAll('&', '&amp;')
				.replaceAll('<', '&lt;')
				.replaceAll('>', '&gt;')
				.replaceAll('{', '&#123;')
				.replaceAll('}', '&#125;');
			(node as Node & { type: string; value: string }).type = 'html';
			node.value = `<code>${ent}</code>`;
		}
		return;
	}
	if (node.type === 'text' && typeof node.value === 'string') {
		node.value = node.value
			.replaceAll('{', '&#123;')
			.replaceAll('}', '&#125;')
			.replaceAll('<', '&lt;');
		return;
	}
	for (const c of node.children ?? []) svelteSafe(c);
}

const DIRECTIVE = /^MODULE:\s*(ogygia(?:\/[\w/-]+)?)\s*$/;

/** The directive text of a `> MODULE: x` blockquote (a single paragraph of plain text), or null. */
function directiveOf(node: Node): string | null {
	if (node.type !== 'blockquote' || node.children?.length !== 1) return null;
	const p = node.children[0]!;
	if (p.type !== 'paragraph' || p.children?.length !== 1) return null;
	const t = p.children[0]!;
	if (t.type !== 'text' || typeof t.value !== 'string') return null;
	return DIRECTIVE.exec(t.value.trim())?.[1] ?? null;
}

// filename → the d.ts files its expansions read (for the `dependencies` hook).
const file_deps = new Map<string, string[]>();

export function expandApi() {
	return async function transform(tree: Node, file: { filename?: string; history?: string[] }) {
		const parent_lists: Array<{ children: Node[] }> = [];
		const walk = (n: Node) => {
			if (n.children) {
				parent_lists.push(n as { children: Node[] });
				for (const c of n.children) walk(c);
			}
		};
		walk(tree);

		const filename = file.filename ?? file.history?.[0] ?? '';
		let deps: string[] = [];
		for (const parent of parent_lists) {
			for (let i = 0; i < parent.children.length; i++) {
				const id = directiveOf(parent.children[i]!);
				if (!id) continue;
				const mod = await extractModule(id);
				deps = deps.concat(mod.files);
				const md = renderModule(mod);
				const sub = fromMarkdown(md) as unknown as { children: Node[] };
				for (const c of sub.children) svelteSafe(c);
				parent.children.splice(i, 1, ...sub.children);
				i += sub.children.length - 1;
			}
		}
		if (filename) file_deps.set(filename, deps);
	};
}

/** Bump when the GENERATOR itself changes shape — its code is as much an input as the d.ts set. */
const GENERATOR_VERSION = 'v2';

/** Doc-cache identity: changes whenever the package's d.ts set — or this generator — does. */
export function expandApiCacheKey(): string {
	return `api-ref:${GENERATOR_VERSION}:` + distStampCached();
}

/** The d.ts files a document's expansions read — Vite watches them in dev. */
export function expandApiDependencies(filename: string): string[] {
	return file_deps.get(filename) ?? [];
}
