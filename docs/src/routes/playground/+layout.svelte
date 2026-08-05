<script lang="ts">
	import Logo from '$lib/Logo.svelte';
	import SiteNav from '$lib/SiteNav.svelte' with { hydrate: '(max-width: 767px)' };

	let { children } = $props();

	const links = [
		{ href: '/playground/strategies', label: 'Strategies' },
		{ href: '/playground/server-islands', label: 'Server' },
		{ href: '/playground/lakes', label: 'Lakes' },
		{ href: '/playground/data', label: 'Data' },
		{ href: '/playground/router', label: 'Router' },
		{ href: '/playground/mutation-guard', label: 'Guard' },
		{ href: '/', label: 'Docs', outbound: true }
	];
</script>

<SiteNav brandHref="/playground" brandLabel="ogygia / playground" {links} />

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

	@media (max-width: 767px) {
		.pg-body {
			padding-top: 2.5rem;
			padding-bottom: calc(var(--nav-h) + 3rem);
		}
	}
</style>
