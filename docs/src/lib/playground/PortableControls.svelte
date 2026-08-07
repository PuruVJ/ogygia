<script lang="ts">
	// Serializable props only — never pass component constructors across the island boundary.
	let {
		active,
		items
	}: {
		active: string;
		items: { key: string; label: string }[];
	} = $props();
</script>

<nav class="portable-controls" data-portable-controls aria-label="Choose widget">
	{#each items as item (item.key)}
		<a
			class="pill"
			href="?widget={item.key}"
			data-sveltekit-noscroll
			aria-current={active === item.key ? 'page' : undefined}
		>
			{item.label}
		</a>
	{/each}
</nav>

<style>
	.portable-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		height: 34px;
		padding-inline: 0.95rem;
		border-radius: var(--r-sm);
		border: 1px solid var(--line-strong);
		background: var(--bg-raised);
		color: var(--text-dim);
		font: 500 0.8125rem/1 var(--font-body);
		transition:
			border-color 120ms ease,
			color 120ms ease,
			background-color 120ms ease;
	}
	.pill:hover {
		border-color: var(--accent-line);
		color: var(--accent);
	}
	.pill[aria-current='page'] {
		border-color: var(--accent-line);
		background: var(--accent-deep);
		color: var(--accent);
	}
</style>
