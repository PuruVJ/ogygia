<script lang="ts">
	// THE ELEMENT-ORDER LAB (e2e/element-order.spec.ts): a panel inside a custom element whose runtime
	// re-appends its element children at upgrade (inside an `{#if}`, so its block comments stay behind
	// and the panel ends up after its own closing marker). The fallback renders it empty, the hole full.
	import type { Snippet } from 'svelte';
	let { full, open = true }: { full: boolean; open?: boolean; ogygiaFallback?: Snippet } = $props();
</script>

<eo-shell>
	{#if open}
		<section class="panel" data-eo-panel>
			{#if full}{#each [1, 2, 3] as i}<div id={`eo-row-${i}`}>row {i}</div>{/each}{/if}
		</section>
	{/if}
</eo-shell>
