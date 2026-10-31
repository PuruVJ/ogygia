<script lang="ts">
	// A waking island that reads the page-set context value and counts clicks.
	import { getContext } from 'svelte';
	const v = getContext<string>('mx-design') ?? 'unset';
	let n = $state(0);
</script>

<button data-bumper data-ctx-read="island" onclick={() => (n += 1)}
	>{v} <span data-bumper-n>{n}</span></button
>
