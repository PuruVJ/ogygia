<script lang="ts">
	import '$lib/styles/widget.css';

	let beats = $state(0);
	let pulsing = $state(true);
</script>

<div class="widget" data-pulse-widget>
	<span class="widget-label">pulse</span>
	<div class="widget-row">
		<span class="widget-value" data-beats class:is-pulsing={pulsing}>{beats}</span>
		<button type="button" data-inc onclick={() => (beats += 1)}>Beat</button>
	</div>
	<button type="button" class="widget-secondary" data-toggle onclick={() => (pulsing = !pulsing)}>
		{pulsing ? 'Pause pulse' : 'Resume pulse'}
	</button>
	<p class="widget-meta">Portable island · hydrate: load</p>
</div>

<style>
	.is-pulsing {
		animation: pulse-beat 1.1s ease-in-out infinite;
	}
	@keyframes pulse-beat {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.55;
			transform: scale(0.96);
		}
	}
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
