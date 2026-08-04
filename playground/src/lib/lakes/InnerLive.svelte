<script lang="ts">
	// Island-in-lake. Authored INSIDE the lake component (FrozenBox). On the client the lake ships
	// no code, but THIS island's `<ogygia-region hydrate>` is emitted into the SSR DOM (lifted +
	// restored by the parent island), so it self-hydrates exactly once — the lake reset its subtree
	// to "dead", so the nearest-boundary rule wakes it.
	let n = $state(0);
</script>

<span class="island" data-inner-live>
	<button data-inner-btn onclick={() => (n += 1)}>inner island (self-hydrates): {n}</button>
</span>
