<script lang="ts">
	import type { Snippet } from 'svelte';
	import Logo from '$lib/Logo.svelte';

	let {
		meta,
		links
	}: {
		meta: string;
		links: Snippet;
	} = $props();
</script>

<footer class="site-footer">
	<div class="shell footer-inner">
		<div class="footer-brand">
			<Logo size={28} stroke={2} decorative />
			<span class="footer-meta">{meta}</span>
		</div>
		<div class="footer-links">
			{@render links()}
		</div>
	</div>
</footer>

<style>
	.site-footer {
		border-top: 1px solid var(--line);
		padding-block: 2.5rem 3.5rem;
		margin-top: 2rem;
	}

	.footer-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.5rem;
		flex-wrap: wrap;
	}

	.footer-brand {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--text-faint);
	}

	.footer-meta {
		font: 400 0.75rem/1 var(--font-mono);
		color: var(--text-faint);
	}

	.footer-links {
		display: flex;
		gap: 1.25rem;
	}

	.footer-links :global(a) {
		font: 500 0.8125rem/1 var(--font-body);
		color: var(--text-dim);
	}

	.footer-links :global(a:hover) {
		color: var(--text);
	}
</style>
