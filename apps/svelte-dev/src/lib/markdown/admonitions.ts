/**
 * svelte.dev admonition blockquotes, as a rehype (hast) plugin — app-local, wired through ogygia's
 * `markdown.rehype` contract. Ports the `blockquote()` handler from @sveltejs/site-kit's renderer:
 *
 *   > [!NOTE] …        →  <blockquote class="note">…</blockquote>
 *   > [!DETAILS] Title →  <blockquote class="note"><details><summary>Title</summary>…</details></blockquote>
 *   > [!LEGACY] …      →  <blockquote><details class="legacy"><summary>Legacy mode</summary>…</details></blockquote>
 *   > [!DEPRECATED] …  →  <blockquote class="deprecated">…</blockquote>
 *
 * Loosely typed (no `hast`/`unist-util-visit` dep) — a hast node is `{ type, tagName, properties,
 * children, value }`.
 */
type Node = {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: Node[];
};

const MARKER = /^\s*\[!(NOTE|LEGACY|DETAILS|DEPRECATED)\]\s?/;

function add_class(props: Record<string, unknown>, cls: string) {
	const cur = props.className;
	props.className = Array.isArray(cur) ? [...cur, cls] : cur ? [String(cur), cls] : [cls];
}

/**
 * The first text node with real content (the marker lives at the very start of the blockquote's
 * first paragraph). Whitespace-only text nodes are skipped — hast keeps the `\n` between
 * `<blockquote>` and its `<p>` as a text node, which would otherwise shadow the marker.
 */
function first_text(node: Node): Node | null {
	if (node.type === 'text') return (node.value ?? '').trim() === '' ? null : node;
	for (const k of node.children ?? []) {
		const t = first_text(k);
		if (t) return t;
	}
	return null;
}

function details(summary: string, children: Node[], cls?: string): Node {
	return {
		type: 'element',
		tagName: 'details',
		properties: cls ? { className: [cls] } : {},
		children: [
			{ type: 'element', tagName: 'summary', properties: {}, children: [{ type: 'text', value: summary }] },
			...children
		]
	};
}

function transform(bq: Node) {
	const text = first_text(bq);
	if (!text || typeof text.value !== 'string') return;
	const m = MARKER.exec(text.value);
	if (!m) return;
	const kind = m[1];
	text.value = text.value.slice(m[0].length);
	const props = (bq.properties ??= {});

	if (kind === 'NOTE') {
		add_class(props, 'note');
	} else if (kind === 'DEPRECATED') {
		add_class(props, 'deprecated');
	} else if (kind === 'DETAILS') {
		// Title is the rest of the first line; body is everything after.
		const nl = text.value.indexOf('\n');
		const title = (nl === -1 ? text.value : text.value.slice(0, nl)).trim() || 'Details';
		text.value = nl === -1 ? '' : text.value.slice(nl + 1);
		add_class(props, 'note');
		bq.children = [details(title, bq.children ?? [])];
	} else if (kind === 'LEGACY') {
		bq.children = [details('Legacy mode', bq.children ?? [], 'legacy')];
	}
}

export function rehypeAdmonitions() {
	return (tree: Node) => {
		const walk = (node: Node) => {
			if (!node.children) return;
			for (const child of node.children) {
				if (child.type === 'element' && child.tagName === 'blockquote') transform(child);
				walk(child);
			}
		};
		walk(tree);
	};
}
