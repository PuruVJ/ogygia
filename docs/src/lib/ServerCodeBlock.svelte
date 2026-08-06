<script lang="ts">
	/**
	 * Server-island code highlighter. Import only with `{ defer: … }` so this module (and Shiki)
	 * stay on the server; the browser receives HTML from the region endpoint.
	 *
	 * For static docs pages, prefer highlighting in `+page.server.ts` and `<CodeBlock html={…} />`
	 * to avoid a hole fetch per block.
	 *
	 * Shiki is loaded lazily inside `highlight()` — not at module evaluate time.
	 */
	import { highlight } from '$lib/code/highlight.server.js';
	import '$lib/styles/code-block.css';

	let {
		code,
		lang = 'typescript',
		class: className = 'code-only'
	}: {
		code: string;
		lang?: string;
		class?: string;
	} = $props();

	const html = await highlight(code, lang);
</script>

<div class={className}>
	{@html html}
</div>
