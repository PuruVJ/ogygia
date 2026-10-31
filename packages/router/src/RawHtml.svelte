<script lang="ts">
	/**
	 * The page component behind an html view (a resolver that answered `{ __oghtml, html }`, a mounted
	 * document): the html is finished, this just drops it in. Static: ships as HTML, no client JS.
	 */
	let { html }: { html: string } = $props();
</script>

{@html html}
