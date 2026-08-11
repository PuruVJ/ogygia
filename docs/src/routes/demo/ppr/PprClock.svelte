<script lang="ts">
	// A deferred server island (the hole). Its HTML is rendered when the hole FETCHES — per request,
	// not baked into the static shell. So this timestamp is fresh on every reload, proving the hole
	// is dynamic while the shell around it is a frozen static file.
	const at = new Date().toLocaleTimeString();
</script>

<div class="ppr-cell ppr-cell--hole" data-ppr-hole>
	<span class="ppr-k">hole · fetched per request</span>
	<strong class="ppr-t">{at}</strong>
</div>

<style>
	.ppr-cell {
		display: grid;
		gap: 0.35rem;
		padding: 1rem 1.1rem;
		border-radius: 12px;
		border: 1px solid var(--line-strong, #2a2a2a);
	}
	.ppr-cell--hole {
		border-color: color-mix(in srgb, var(--accent, #4ade80) 55%, transparent);
		background: color-mix(in srgb, var(--accent, #4ade80) 10%, transparent);
	}
	.ppr-k {
		font: 600 0.6875rem/1 var(--font-mono, monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		opacity: 0.7;
	}
	.ppr-t {
		font: 600 1.5rem/1 var(--font-mono, monospace);
		font-variant-numeric: tabular-nums;
	}
</style>
