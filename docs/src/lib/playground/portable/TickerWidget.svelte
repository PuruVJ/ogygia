<script lang="ts">
	import '$lib/styles/widget.css';

	let ticks = $state(0);
	let step = $state(1);
</script>

<div class="widget" data-ticker-widget>
	<span class="widget-label">ticker</span>
	<div class="widget-row">
		<span class="widget-value" data-ticks>{ticks}</span>
		<button type="button" data-inc onclick={() => (ticks += step)}>
			+{step}
		</button>
	</div>
	<button
		type="button"
		class="widget-secondary"
		data-toggle
		onclick={() => (step = step === 1 ? 5 : 1)}
	>
		Step {step === 1 ? '→ 5' : '→ 1'}
	</button>
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
