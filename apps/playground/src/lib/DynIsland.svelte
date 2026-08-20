<script lang="ts">
	// A component that WANTS to be a wake:load island. Its onMount bumps a window counter so we can
	// tell from the outside whether it actually hydrated.
	import { onMount } from 'svelte';
	let n = $state(0);
	onMount(() => {
		(window as unknown as { __dynMounted?: number }).__dynMounted =
			((window as unknown as { __dynMounted?: number }).__dynMounted ?? 0) + 1;
	});
</script>

<button data-dyn-island onclick={() => n++}>dyn island {n}</button>
