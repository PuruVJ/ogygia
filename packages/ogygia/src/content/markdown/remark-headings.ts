/**
 * Collect `h2`–`h4` into `metadata.headings` and auto-slug any heading without an explicit
 * `{#id}`. Runs **after** {@link remarkHeadingId} so pandoc-style explicit ids win.
 *
 * The collected array is stashed on `file.data.fm.headings`, which mdsvex emits as part of the
 * module `metadata` export. The `mdsvex` format adapter lifts it back off `metadata` so it never
 * pollutes validated `data`.
 */
import type { Heading } from '../index.js';

const SLUG_STRIP_NON_ALNUM = /[^\p{L}\p{N} \-_]/gu;
const SLUG_WS_UNDER = /[\s_]+/g;
const SLUG_MULTI_DASH = /-+/g;
const SLUG_EDGE_DASH = /^-|-$/g;

type MdNode = {
	type?: string;
	depth?: number;
	value?: string;
	children?: MdNode[];
	data?: { hProperties?: Record<string, string> } & Record<string, unknown>;
};

/** GitHub-ish slug: lowercase, strip punctuation, spaces → dashes. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(SLUG_STRIP_NON_ALNUM, '')
		.replace(SLUG_WS_UNDER, '-')
		.replace(SLUG_MULTI_DASH, '-')
		.replace(SLUG_EDGE_DASH, '');
}

export type RemarkHeadingsOptions = {
	/** Shallowest depth to collect (default 2). */
	minDepth?: 2 | 3 | 4;
	/** Deepest depth to collect (default 4). */
	maxDepth?: 2 | 3 | 4;
};

export function remarkHeadings(options: RemarkHeadingsOptions = {}) {
	const min = options.minDepth ?? 2;
	const max = options.maxDepth ?? 4;

	return (tree: MdNode, file: { data: Record<string, unknown> }) => {
		const headings: Heading[] = [];
		const seen = new Map<string, number>();

		// mdsvex escapes Svelte-reserved chars (`{` → `&#123;`, `}` → `&#125;`) before this plugin
		// sees the AST, so inline-code heading text arrives entity-encoded. Decode it back to plain
		// text for the TOC (the id slug strips these anyway; the display text must not show `&#123;`).
		const decodeEntities = (s: string): string =>
			s
				.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
				.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#39;|&apos;/g, "'")
				.replace(/&amp;/g, '&');

		const textOf = (node: MdNode): string => {
			if (typeof node.value === 'string') return node.value;
			if (Array.isArray(node.children)) return node.children.map(textOf).join('');
			return '';
		};

		const walk = (node: MdNode) => {
			if (
				node.type === 'heading' &&
				typeof node.depth === 'number' &&
				node.depth >= min &&
				node.depth <= max
			) {
				const text = decodeEntities(textOf(node)).trim();
				const data = (node.data ??= {});
				const props = (data.hProperties ??= {});
				let id = props.id;
				if (!id) {
					const base = slugify(text) || 'section';
					const n = seen.get(base) ?? 0;
					seen.set(base, n + 1);
					id = n ? `${base}-${n}` : base;
					props.id = id;
				} else {
					// keep explicit ids in the dedupe pool so a later auto-slug can't collide
					seen.set(id, (seen.get(id) ?? 0) + 1);
				}
				headings.push({ depth: node.depth as 2 | 3 | 4, id, text });
			}
			if (Array.isArray(node.children)) node.children.forEach(walk);
		};

		walk(tree);

		const fm = (file.data.fm ??= {}) as Record<string, unknown>;
		fm.headings = headings;
	};
}
