<script lang="ts">
	// A plain component reading a page-set context value (the page sets it with ogygia's setContext).
	import { getContext } from 'svelte';
	let { label = '' }: { label?: string } = $props();
	const v = getContext<string>('mx-design') ?? 'unset';
</script>

<span data-ctx-read={label}>{v}</span>
