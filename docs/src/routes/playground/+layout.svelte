<script lang="ts">
	import Logo from '$lib/Logo.svelte';

	let { children } = $props();
</script>

<div class="pg-body">
	{@render children()}
</div>

<footer class="site-footer">
	<div class="shell footer-inner">
		<div class="footer-brand">
			<Logo size={28} stroke={2} decorative />
			<span class="footer-meta">ogygia playground · live demos of the region model</span>
		</div>
		<div class="footer-links">
			<a href="/" data-back-to-docs>Back to docs</a>
			<a href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer">GitHub</a>
		</div>
	</div>
</footer>

<style>
	.pg-body {
		padding-top: 2.5rem;
		padding-bottom: 3rem;
		min-height: 60vh;
	}

	@media (max-width: 1099px) {
		.pg-body {
			padding-bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px));
		}
	}
</style>
