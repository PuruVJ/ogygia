<script lang="ts">
	// Island-in-lake. Authored INSIDE the lake (FrozenReport). The lake ships no code, but this
	// island's `<ogygia-region hydrate>` is still emitted into the SSR DOM (lifted + restored by the
	// parent island), so the nearest-boundary rule wakes it: it self-hydrates exactly once.
	let n = $state(0);
</script>

<button type="button" class="inner-badge" data-inner-badge onclick={() => (n += 1)}>
	live inside frozen water · {n}
</button>

<style>
	.inner-badge {
		align-self: flex-start;
		height: 30px;
		padding-inline: 0.75rem;
		border-radius: var(--r-sm);
		border: 1px solid var(--accent-line);
		background: var(--accent-deep);
		color: var(--accent);
		font: 500 0.75rem/1 var(--font-body);
		cursor: pointer;
		transition: background-color 120ms ease;
	}
	.inner-badge:hover {
		background: var(--accent);
		color: var(--text-on-invert);
	}
</style>
