/**
 * A tiny remark plugin that reshapes Keep-a-Changelog version headings for the Releases page.
 *
 * `## [0.5.0] — 2026-08-12`  →  an `<h2>0.5.0</h2>` (clean, so the id/anchor and the on-this-page TOC
 * read "0.5.0") followed by a `<time class="release-date" datetime="2026-08-12">August 12, 2026</time>`
 * — the date drops UNDER the version, formatted (not raw ISO) via `Intl` at build. The machine-readable
 * ISO stays in `datetime=` so a client island can re-format it to each visitor's own locale. Runs
 * `enforce: 'pre'` so the built-in heading-id + TOC collectors see the trimmed text.
 *
 * Only top-level `##` headings that match `[version] — YYYY-MM-DD` are touched; every other doc is
 * inert (nothing else has that shape), so this is safe on the shared markdown pipeline. Hand-rolled
 * walk — no `unist-util-visit` dependency, and version headings are always top-level, so no recursion.
 */
const VERSION_DATE = /^\[?\s*([\w.-]+?)\s*\]?\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/;

type MdastNode = { type: string; depth?: number; value?: string; children?: MdastNode[]; data?: unknown };

function text_of(node: MdastNode): string {
	if (node.value != null) return node.value;
	return (node.children ?? []).map(text_of).join('');
}

// Build-time default format (visitors get their own locale via the LocaleDates island). `T00:00:00`
// keeps it at local midnight so the day never shifts across a timezone.
const DATE_FMT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
function pretty_date(iso: string): string {
	const d = new Date(iso + 'T00:00:00');
	return Number.isNaN(+d) ? iso : DATE_FMT.format(d);
}

export function remarkChangelog() {
	return (tree: MdastNode) => {
		const kids = tree.children;
		if (!kids) return;
		for (let i = 0; i < kids.length; i++) {
			const node = kids[i];
			if (node.type !== 'heading' || node.depth !== 2) continue;
			const m = text_of(node).match(VERSION_DATE);
			if (!m) continue;
			node.children = [{ type: 'text', value: m[1] }];
			kids.splice(i + 1, 0, {
				type: 'paragraph',
				// `hName: 'time'` renders a <time> (not <p>); the ISO rides `datetime=` for the island.
				data: { hName: 'time', hProperties: { className: ['release-date'], datetime: m[2] } },
				children: [{ type: 'text', value: pretty_date(m[2]) }]
			});
			i++; // step over the date node we just inserted
		}
	};
}
