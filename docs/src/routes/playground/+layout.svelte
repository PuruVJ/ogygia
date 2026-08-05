<script lang="ts">
	import Logo from '$lib/Logo.svelte';

	let { children } = $props();

	const links = [
		{ href: '/playground/strategies', label: 'Strategies' },
		{ href: '/playground/server-islands', label: 'Server' },
		{ href: '/playground/lakes', label: 'Lakes' },
		{ href: '/playground/data', label: 'Data' },
		{ href: '/playground/router', label: 'Router' },
		{ href: '/playground/mutation-guard', label: 'Guard' }
	];
</script>

<nav class="nav">
	<div class="shell nav-inner">
		<a class="nav-brand" href="/playground">
			<Logo size={20} />
			<span class="nav-wordmark">ogygia / playground</span>
		</a>
		<div class="nav-links">
			{#each links as link}
				<a class="nav-link" href={link.href}>{link.label}</a>
			{/each}
			<a class="nav-link" href="/" data-back-to-docs>Docs</a>
		</div>
	</div>
</nav>

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
		padding-top: calc(var(--nav-h) + 2.5rem);
		padding-bottom: 3rem;
		min-height: 60vh;
	}
</style>
