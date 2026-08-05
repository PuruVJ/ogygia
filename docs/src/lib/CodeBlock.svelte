<script lang="ts">
	/**
	 * Renders Shiki HTML produced on the server (`highlight.server.ts` in a `+page.server.ts`
	 * load, or inside a `defer` server island). This component has no Shiki import — the browser
	 * only ever sees the finished markup.
	 */
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
