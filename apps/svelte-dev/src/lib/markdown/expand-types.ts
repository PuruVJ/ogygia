/**
 * `> MODULE: svelte/motion` / `> TYPES: Configuration#Config` — svelte.dev's reference-page codegen
 * directives, as a remark plugin. Wired `{ enforce: 'pre', plugin: expandTypes }` so the generated
 * headings/fences flow through ogygia's built-in passes (TOC, anchors, code ids, link audit) exactly
 * as if hand-authored. The generated markdown comes from the INSTALLED packages' own `.d.ts`
 * (see type-docs.ts) and is parsed back to mdast to splice in place of the directive blockquote.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { render_module, render_types } from './type-docs.ts';

type Node = { type: string; value?: string; children?: Node[] };

const DIRECTIVE = /^(MODULE|TYPES):\s*(.+)\s*$/;

/** The directive text of a `> MODULE: x` blockquote (a single paragraph of plain text), or null. */
function directive_of(node: Node): { kind: 'MODULE' | 'TYPES'; arg: string } | null {
	if (node.type !== 'blockquote' || node.children?.length !== 1) return null;
	const p = node.children[0]!;
	if (p.type !== 'paragraph' || p.children?.length !== 1) return null;
	const t = p.children[0]!;
	if (t.type !== 'text' || typeof t.value !== 'string') return null;
	const m = DIRECTIVE.exec(t.value.trim());
	return m ? { kind: m[1] as 'MODULE' | 'TYPES', arg: m[2]!.trim() } : null;
}

/**
 * mdsvex's serializer emits text / inline-code VALUES verbatim into the Svelte source (it doesn't
 * re-escape), so any `<` or `{` in the generated tree must be pre-escaped as entities HERE — the
 * svelte parser sees `&lt;`, the reader sees `<`. Fences are exempt (the highlighter escapes).
 */
function escape_tree(node: Node) {
	if (node.type === 'text' || node.type === 'inlineCode') {
		if (typeof node.value === 'string') {
			node.value = node.value
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/\{/g, '&#123;')
				.replace(/\}/g, '&#125;');
		}
		return;
	}
	if (node.type === 'code' || node.type === 'html') return;
	node.children?.forEach(escape_tree);
}

export function expandTypes() {
	return async (tree: Node) => {
		// Collect first (splices reindex children), then expand deepest-first is unnecessary — the
		// directives only occur at the top level of the document.
		const jobs: Array<{ parent: Node; index: number; kind: 'MODULE' | 'TYPES'; arg: string }> = [];
		const walk = (parent: Node) => {
			parent.children?.forEach((child, index) => {
				const d = directive_of(child);
				if (d) jobs.push({ parent, index, ...d });
				else walk(child);
			});
		};
		walk(tree);

		// Replace back-to-front so earlier indices stay valid.
		for (const job of jobs.reverse()) {
			const md =
				job.kind === 'MODULE' ? await render_module(job.arg) : await render_types(job.arg);
			if (md == null) {
				console.warn(`[svelte-dev] type-docs: nothing generated for "> ${job.kind}: ${job.arg}" — leaving the directive out`);
				job.parent.children!.splice(job.index, 1);
				continue;
			}
			const generated = fromMarkdown(md) as Node;
			escape_tree(generated);
			job.parent.children!.splice(job.index, 1, ...(generated.children ?? []));
		}
	};
}
