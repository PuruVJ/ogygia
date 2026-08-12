<script module lang="ts">
	// Baked ONCE at MODULE-eval, not per render. In a prod build (prerender = true) that is BUILD time —
	// frozen into the static shell file. In the dev server it is module-load time, cached across
	// requests — so the shell stays frozen on reload in dev too, matching prod. (Instance scope would
	// call `new Date()` every request, making the "static shell" look dynamic in dev.)
	const built = new Date().toLocaleTimeString();
</script>

<script lang="ts">
	import PprClock from './PprClock.svelte' with { render: 'deferred' };

	// The hole re-renders fresh on each reload because a deferred hole is dynamic by default: with no
	// `maxAge` preset it is served `Cache-Control: no-store`. (Opt into caching via a preset's `maxAge`.)
</script>

<main class="ppr">
	<div class="ppr-grid">
		<div class="ppr-cell ppr-cell--shell" data-ppr-shell>
			<span class="ppr-k">shell · baked at build</span>
			<strong class="ppr-t">{built}</strong>
		</div>

		<PprClock>
			{#snippet ogygiaFallback()}
				<div class="ppr-cell ppr-cell--loading">
					<span class="ppr-k">hole · fetching…</span>
					<strong class="ppr-t">— · —</strong>
				</div>
			{/snippet}
		</PprClock>
	</div>

	<p class="ppr-note">
		Reload this frame. The <strong>shell</strong> time never changes — it is a static file. The
		<strong>hole</strong> time changes every time — it is fetched fresh per request. One page, two clocks.
	</p>
</main>

<style>
	:global(body) {
		margin: 0;
	}
	.ppr {
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
	.ppr-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.9rem;
	}
	@media (max-width: 480px) {
		.ppr-grid {
			grid-template-columns: 1fr;
		}
	}
	.ppr-cell {
		display: grid;
		gap: 0.35rem;
		padding: 1rem 1.1rem;
		border-radius: 12px;
		border: 1px solid var(--line-strong, #2a2a2a);
	}
	.ppr-cell--shell {
		background: color-mix(in srgb, var(--bg-raised, #101512) 70%, transparent);
	}
	.ppr-cell--loading {
		opacity: 0.55;
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
	.ppr-note {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.55;
		color: var(--text-dim, #9aa8a0);
	}
</style>
