// A "markdown-ish" renderer for CMS descriptions: nine regex passes over the text, a paragraph
// split, an inline pass per paragraph, and an entity escape pass at the end. Per product, per render.
const PASSES: [RegExp, string][] = [
	[/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'],
	[/\*([^*]+)\*/g, '<em>$1</em>'],
	[/`([^`]+)`/g, '<code>$1</code>'],
	[/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'],
	[/^### (.+)$/gm, '<h3>$1</h3>'],
	[/^## (.+)$/gm, '<h2>$1</h2>'],
	[/^- (.+)$/gm, '<li>$1</li>'],
	[/(\d+)\s?(A|V|kA|mm|kg)\b/g, '<span class="unit">$1&nbsp;$2</span>'],
	[/\b(Lorem|ipsum|dolor)\b/g, '<mark>$1</mark>']
];

function escapeEntities(s: string): string {
	return s.replace(/&(?!(?:amp|lt|gt|quot|nbsp);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(paragraph: string): string {
	let out = paragraph;
	for (const [re, rep] of PASSES) out = out.replace(re, rep);
	return out;
}

export function renderMarkdown(text: string): string {
	const paragraphs = text.split(/\n{2,}|\.\s{2,}/).filter((p) => p.trim());
	return paragraphs.map((p) => `<p>${unescapeTags(escapeEntities(inline(p)))}</p>`).join('\n');
}

// the escape pass above also escaped the tags the passes emitted: put them back (yes, really)
function unescapeTags(s: string): string {
	return s.replace(/&lt;(\/?(?:strong|em|code|a|h2|h3|li|span|mark)(?:\s[^&]*?)?)&gt;/g, '<$1>');
}
