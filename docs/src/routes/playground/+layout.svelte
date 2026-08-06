<script lang="ts">
	import SiteFooter from '$lib/SiteFooter.svelte';

	let { children } = $props();
</script>

<div class="pg-body">
	{@render children()}
</div>

<SiteFooter meta="ogygia playground · live demos of the region model">
	{#snippet links()}
		<a href="/" data-back-to-docs>Back to docs</a>
		<a href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer">GitHub</a>
	{/snippet}
</SiteFooter>

<style>
	.pg-body {
		padding-top: 2.5rem;
		padding-bottom: 3rem;
		min-height: 60vh;
	}

	@media (max-width: 1099px) {
		.pg-body {
			padding-top: 0.75rem;
			padding-bottom: 2.5rem;
		}
	}
</style>
