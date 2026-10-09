<script lang="ts">
	// An island whose children (a lake holding an island) render only while it is open.
	import type { Snippet } from 'svelte';
	let { open: start = false, name, children }: { open?: boolean; name: string; children?: Snippet } = $props();
	let open = $state(start);
</script>

<div data-nest="outer-{name}">
	<button data-nest="toggle-{name}" onclick={() => (open = !open)}>{open ? 'close' : 'open'} {name}</button>
	{#if open}
		<div data-nest="slot-{name}">{@render children?.()}</div>
	{/if}
</div>
