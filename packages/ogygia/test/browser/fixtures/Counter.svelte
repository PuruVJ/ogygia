<script lang="ts">
	// A plain island: server-rendered with `start`, then hydrated in place by the runtime. The
	// browser-mode test asserts the SSR button node is ADOPTED (same node after hydrate), not
	// re-created — Svelte's mismatch recovery would silently replace it (see foreign-dom.md).
	let { start = 0 }: { start?: number } = $props();
	let count = $state(start);
</script>

<p>
	<span data-testid="count">{count}</span>
	<button type="button" onclick={() => count++}>add</button>
</p>
