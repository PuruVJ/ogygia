<script lang="ts">
	/**
	 * Renders Shiki HTML baked at build (`snippets.remote.ts` via Kit `prerender()`, or a `defer`
	 * server island that calls `highlight.server.ts`). No Shiki in the browser — only finished markup.
	 */
	import '$lib/styles/code-block.css';

	let {
		html,
		class: className = 'code-only'
	}: {
		html: string;
		class?: string;
	} = $props();
</script>

<div class={className}>
	{@html html}
</div>
