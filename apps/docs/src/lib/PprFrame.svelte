<script lang="ts">
	// Embeds the prerendered /demo/ppr page in an iframe with a reload button. Remounting the iframe
	// (via {#key}) refetches the static shell (same baked time) and re-renders the hole (fresh time),
	// so the reader can watch partial prerendering happen. This host is a tiny client island.
	//
	// The hole re-renders fresh on each reload because a deferred hole is `no-store` by default (it is
	// dynamic unless a preset's `maxAge` opts it into a browser cache), so the reloaded iframe refetches.
	let n = $state(0);
</script>

<div class="ppr-frame">
	<div class="ppr-frame-bar">
		<span class="ppr-frame-url">/demo/ppr <em>· prerendered static file</em></span>
		<button type="button" class="ppr-frame-reload" onclick={() => (n += 1)}>
			Reload ↻
		</button>
	</div>
	{#key n}
		<iframe class="ppr-frame-view" title="Partial prerendering demo" src="/demo/ppr"></iframe>
	{/key}
</div>

<style>
	.ppr-frame {
		border: 1px solid color-mix(in srgb, var(--accent-line, currentColor) 45%, var(--line, #333));
		border-radius: 14px;
		overflow: hidden;
		background: var(--bg-raised, #0c110e);
	}
	.ppr-frame-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.55rem 0.75rem;
		border-bottom: 1px solid var(--line, #262b28);
		background: color-mix(in srgb, var(--bg-raised, #0c110e) 70%, transparent);
	}
	.ppr-frame-url {
		font: 500 0.78rem/1 var(--font-mono, monospace);
		color: var(--text-dim, #9aa8a0);
	}
	.ppr-frame-url em {
		opacity: 0.6;
		font-style: normal;
	}
	.ppr-frame-reload {
		font: 600 0.78rem/1 var(--font-mono, monospace);
		padding: 0.4rem 0.7rem;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--accent, #4ade80) 55%, var(--line, #333));
		background: color-mix(in srgb, var(--accent, #4ade80) 12%, transparent);
		color: var(--text, #e6eee9);
		cursor: pointer;
		transition: background 140ms ease;
	}
	.ppr-frame-reload:hover {
		background: color-mix(in srgb, var(--accent, #4ade80) 22%, transparent);
	}
	.ppr-frame-view {
		display: block;
		width: 100%;
		height: 320px;
		border: 0;
		background: var(--bg, #060907);
	}
</style>
