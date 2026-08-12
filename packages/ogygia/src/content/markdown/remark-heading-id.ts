const HEADING_ID_CAPTURE = /\s*\{#([A-Za-z0-9_:-]+)\}\s*$/;
const HEADING_ID_STRIP = /\s*\{#[A-Za-z0-9_:-]+\}\s*$/;

/**
 * Pandoc-style `## Title {#custom-id}` → heading `id="custom-id"`.
 * Runs before mdsvex escapes `{…}` for Svelte.
 */
export function remarkHeadingId() {
	return (tree: { type?: string; children?: unknown[]; data?: Record<string, unknown> }) => {
		walk(tree);
	};

	function walk(node: {
		type?: string;
		children?: unknown[];
		data?: Record<string, unknown>;
		depth?: number;
	}) {
		if (node.type === 'heading' && Array.isArray(node.children)) {
			const last = node.children.at(-1) as { type?: string; value?: string } | undefined;
			if (last?.type === 'text' && typeof last.value === 'string') {
				const match = last.value.match(HEADING_ID_CAPTURE);
				if (match) {
					last.value = last.value.replace(HEADING_ID_STRIP, '');
					if (!last.value) node.children.pop();
					const data = (node.data ??= {});
					const props = (data.hProperties ??= {}) as Record<string, string>;
					props.id = match[1]!;
				}
			}
		}
		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				walk(child as typeof node);
			}
		}
	}
}
