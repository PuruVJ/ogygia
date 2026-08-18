/**
 * `+++` / `---` DIFF MARKERS — svelte.dev's fence dialect for "change this code" prose.
 *
 * A line starting `+++ ` reads as ADDED, `--- ` as REMOVED; the marker is stripped before Shiki
 * tokenizes (so highlighting sees clean source) and the line is classed for the theme:
 *
 *   ```js
 *   --- export let count;
 *   +++ let { count } = $props();
 *   ```
 *
 * Ships as a {@link ShikiTransformer} for the fence pipeline's `transformers` slot — the same
 * contract `@shikijs/transformers` speaks — so it composes with twoslash, meta-highlight, and
 * app-authored stages. Inert on fences that carry no marker.
 *
 * Languages where a leading `---` is REAL syntax (yaml's document separator, markdown's rule, the
 * diff language itself) are skipped entirely — mark those with `// [!code ++]` comments from
 * `@shikijs/transformers` instead.
 */
import type { ShikiTransformer } from 'shiki';

const SKIP_LANGS = new Set(['diff', 'yaml', 'yml', 'markdown', 'md', 'mdx', 'svx']);

type DiffState = { add: Set<number>; remove: Set<number> };
const STATE = Symbol('ogygia.diff');

export function diff_markers(): ShikiTransformer {
	return {
		name: 'ogygia:diff-markers',
		preprocess(code) {
			const lang = String(this.options.lang ?? '').toLowerCase();
			if (SKIP_LANGS.has(lang)) return;
			const add = new Set<number>();
			const remove = new Set<number>();
			let n = 0;
			const lines = code.split('\n').map((line) => {
				n++;
				// only the marker-plus-space form (or a bare marker: an added/removed empty line) —
				// a `+++foo` with no space is left alone, it's not the dialect.
				if (line === '+++' || line.startsWith('+++ ')) {
					add.add(n);
					return line.slice(4);
				}
				if (line === '---' || line.startsWith('--- ')) {
					remove.add(n);
					return line.slice(4);
				}
				return line;
			});
			if (!add.size && !remove.size) return;
			(this.meta as Record<symbol, unknown>)[STATE] = { add, remove } satisfies DiffState;
			return lines.join('\n');
		},
		line(node, line) {
			const d = (this.meta as Record<symbol, unknown>)[STATE] as DiffState | undefined;
			if (!d) return;
			if (d.add.has(line)) this.addClassToHast(node, 'og-diff og-diff-add');
			else if (d.remove.has(line)) this.addClassToHast(node, 'og-diff og-diff-remove');
		},
		pre(node) {
			if ((this.meta as Record<symbol, unknown>)[STATE]) this.addClassToHast(node, 'og-has-diff');
		}
	};
}
