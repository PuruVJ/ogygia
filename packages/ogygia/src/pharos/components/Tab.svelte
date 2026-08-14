<script lang="ts">
	/** One panel of a {@link TabGroup}. Renders a STATIC panel (its label rides `data-label`); it carries
	 *  no client behavior — the enclosing island reads the labels from its `labels` prop and shows/hides
	 *  these panels by the active label. */
	import type { Snippet } from 'svelte';
	let { label, children }: { label: string; children: Snippet } = $props();
</script>

<div class="ph-tabs-panel" role="tabpanel" data-label={label} aria-label={label}>
	{@render children()}
</div>
