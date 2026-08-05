<script lang="ts">
	import Counter from '$lib/demos/Counter.svelte' with { hydrate: 'load' };
	import PageHead from '$lib/PageHead.svelte';
</script>

<PageHead
	title="csr = true"
	description="A Kit-hydrated route that keeps the client build available — islands still work as normal components."
/>

<main class="shell" style="padding-top: 6rem; padding-bottom: 4rem;">
	<p class="eyebrow">Kit coexistence</p>
	<h1 style="font-size: clamp(2rem, 4vw, 3rem);">csr = true route</h1>
	<p>
		This route opts into full Kit hydration so the client build stays available. Islands still
		work; Kit hydrates them once as normal components.
	</p>
	<p><a href="/">Back to docs</a></p>
	<div style="margin-top: 2rem; max-width: 280px;">
		<Counter start={42} label="Kit-page counter" />
	</div>
</main>
