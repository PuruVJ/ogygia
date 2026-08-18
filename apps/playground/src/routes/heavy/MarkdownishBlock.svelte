<script lang="ts">
	// String/regex heavy: fakes a markdown-ish transform over a large generated document. This is
	// the shape of real SSR cost when pages format big blobs of text. Attributed to `MarkdownishBlock`.
	let { paragraphs = 400 }: { paragraphs?: number } = $props();

	const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod'.split(' ');
	let doc = '';
	for (let p = 0; p < paragraphs; p++) {
		let line = '';
		for (let w = 0; w < 40; w++) line += words[(p * 7 + w * 13) % words.length] + ' ';
		doc += `## Section ${p}\n${line}**bold** and _em_ and \`code\`\n\n`;
	}

	// several passes of regex replacement — the expensive part
	const htmlOut = doc
		.replace(/^## (.+)$/gm, '<h2>$1</h2>')
		.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
		.replace(/_(.+?)_/g, '<i>$1</i>')
		.replace(/`(.+?)`/g, '<code>$1</code>')
		.replace(/\n\n/g, '</p><p>');

	const chars = htmlOut.length;
</script>

<div class="md">
	<p class="md-note">rendered {paragraphs} sections → {chars.toLocaleString()} chars of HTML</p>
</div>

<style>
	.md-note {
		font-size: 0.8rem;
		color: #4a5568;
	}
</style>
