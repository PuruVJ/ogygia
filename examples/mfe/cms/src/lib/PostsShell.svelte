<script lang="ts">
	import type { Snippet } from 'svelte';
	let { data, children }: { data: { section: string; count: number; site: string }; children: Snippet } = $props();
</script>

<div class="posts" data-testid="posts-shell">
	<p class="crumb">{data.site} · {data.section} ({data.count})</p>
	{@render children()}
</div>

<style>
	.posts { border-left: 3px solid #a78bfa; padding-left: 0.8rem; }
	.crumb { color: #7c3aed; font-size: 0.85rem; margin: 0 0 0.5rem; }
</style>
