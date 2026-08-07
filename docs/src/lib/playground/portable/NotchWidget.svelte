<script lang="ts">
	import '$lib/styles/widget.css';

	let open = $state(false);
	let depth = $state(1);
</script>

<div class="widget" data-notch-widget>
	<span class="widget-label">notch</span>
	<div class="widget-row">
		<span class="widget-value" data-depth>{open ? depth : '—'}</span>
		<button type="button" data-toggle onclick={() => (open = !open)}>
			{open ? 'Close' : 'Open'}
		</button>
	</div>
	{#if open}
		<button
			type="button"
			class="widget-secondary"
			data-inc
			onclick={() => (depth += 1)}
		>
			Deepen notch
		</button>
	{/if}
	<p class="widget-meta">Portable island · hydrate: load</p>
</div>

<style>
	.widget-secondary {
		margin-top: 0.75rem;
		width: 100%;
		height: 32px;
		padding-inline: 0.85rem;
		border-radius: var(--r-sm);
		border: 1px solid var(--line-strong);
		background: transparent;
		color: var(--text-dim);
		font: 500 0.75rem/1 var(--font-mono);
		cursor: pointer;
	}
	.widget-secondary:hover {
		border-color: var(--accent-line);
		color: var(--accent);
	}
</style>
