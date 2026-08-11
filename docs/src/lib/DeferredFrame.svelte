<script lang="ts">
	// Embeds the /demo/deferred canvas in an iframe with a "Fetch again" button. Remounting the iframe
	// (via {#key}) reloads the prerendered shell and replays the deferred fetch: the fallback shows,
	// then the freshly-rendered server HTML swaps in. The hole is `no-store` by default, so every
	// replay is a real round-trip with a new timestamp. This host is a tiny client island.
	let n = $state(0);
</script>

<div class="dfd-frame">
	<div class="dfd-frame-bar">
		<span class="dfd-frame-url">/demo/deferred <em>· server island (a hole)</em></span>
		<button type="button" class="dfd-frame-reload" onclick={() => (n += 1)}> Fetch again ↻ </button>
	</div>
	{#key n}
		<iframe class="dfd-frame-view" title="Deferred server-island demo" src="/demo/deferred"></iframe>
	{/key}
</div>

<style>
	.dfd-frame {
		border: 1px solid color-mix(in srgb, var(--accent-line, currentColor) 45%, var(--line, #333));
		border-radius: 14px;
		overflow: hidden;
		background: var(--bg-raised, #0c110e);
	}
	.dfd-frame-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.55rem 0.75rem;
		border-bottom: 1px solid var(--line, #262b28);
		background: color-mix(in srgb, var(--bg-raised, #0c110e) 70%, transparent);
	}
	.dfd-frame-url {
		font: 500 0.78rem/1 var(--font-mono, monospace);
		color: var(--text-dim, #9aa8a0);
	}
	.dfd-frame-url em {
		opacity: 0.6;
		font-style: normal;
	}
	.dfd-frame-reload {
		font: 600 0.78rem/1 var(--font-mono, monospace);
		padding: 0.4rem 0.7rem;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--accent, #4ade80) 55%, var(--line, #333));
		background: color-mix(in srgb, var(--accent, #4ade80) 12%, transparent);
		color: var(--text, #e6eee9);
		cursor: pointer;
		transition: background 140ms ease;
	}
	.dfd-frame-reload:hover {
		background: color-mix(in srgb, var(--accent, #4ade80) 22%, transparent);
	}
	.dfd-frame-view {
		display: block;
		width: 100%;
		height: 240px;
		border: 0;
		background: var(--bg, #060907);
	}
</style>
