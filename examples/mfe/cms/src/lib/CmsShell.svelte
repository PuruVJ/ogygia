<script lang="ts">
	import type { Snippet } from 'svelte';
	let { data, children }: {
		data: { site: string; base: string; viewer: { sub?: string; roles?: string[] } | null };
		children: Snippet;
	} = $props();
</script>

<div class="cms" data-testid="cms-shell">
	<nav>
		<strong>{data.site}</strong>
		{#if data.viewer}<span data-testid="cms-greeting">salut {data.viewer.sub}</span>{:else}<span data-testid="cms-anon">visiteur</span>{/if}
		<a href="{data.base}/">home</a>
		<a href="{data.base}/posts/1">post 1</a>
		<a href="{data.base}/posts/2">post 2</a>
	</nav>
	{@render children()}
</div>

<style>
	.cms {
		border: 2px solid #7c3aed;
		border-radius: 10px;
		padding: 1rem;
		font-family: system-ui, sans-serif;
	}
	nav {
		display: flex;
		gap: 0.8rem;
		border-bottom: 1px solid #ddd6fe;
		padding-bottom: 0.5rem;
		margin-bottom: 0.8rem;
	}
	nav strong { color: #6d28d9; }
</style>
