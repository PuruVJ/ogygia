<script lang="ts">
	// A deferred server island (a hole). Its `ogygiaFallback` renders in the initial HTML; the runtime
	// fetches the real HTML from the signed endpoint and swaps it in. The hole is `no-store` by default,
	// so each fresh load (the embedding frame's "Fetch again") re-renders it on the server.
	import DeferredHole from './DeferredHole.svelte' with { render: 'deferred' };
</script>

<main class="dfd">
	<DeferredHole>
		{#snippet ogygiaFallback()}
			<div class="dh dh--loading" data-deferred-fallback>
				<span class="dh-k">hole · fetching…</span>
				<strong class="dh-t">— · —</strong>
			</div>
		{/snippet}
	</DeferredHole>

	<p class="dfd-note">
		The card starts as a <strong>fallback</strong>, then the server HTML is fetched and swapped in.
		Hit <strong>Fetch again</strong> to watch the round-trip replay — the timestamp is fresh each time.
	</p>
</main>

<style>
	:global(body) {
		margin: 0;
	}
	.dfd {
		box-sizing: border-box;
		min-height: 100dvh;
		display: grid;
		align-content: center;
		gap: 1.25rem;
		padding: 1.5rem;
		font-family: var(--font-body, system-ui, sans-serif);
		color: var(--text, #e6eee9);
		background: var(--bg, #060907);
	}
	.dh {
		display: grid;
		gap: 0.35rem;
		padding: 1rem 1.1rem;
		border-radius: 12px;
		border: 1px solid var(--line-strong, #2a2a2a);
	}
	.dh--loading {
		opacity: 0.55;
	}
	.dh-k {
		font: 600 0.6875rem/1 var(--font-mono, monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		opacity: 0.7;
	}
	.dh-t {
		font: 600 1.5rem/1 var(--font-mono, monospace);
		font-variant-numeric: tabular-nums;
	}
	.dfd-note {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.55;
		color: var(--text-dim, #9aa8a0);
	}
</style>
