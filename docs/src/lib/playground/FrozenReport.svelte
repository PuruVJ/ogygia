<script lang="ts">
	// A LAKE (imported `with { hydrate: 'none' }` inside a hydrated island). Its code ships in NO
	// client chunk — the island's client module swaps this import for a placeholder. It SSRs inline;
	// the runtime lifts and restores its DOM around the parent hydrate. Its own button is INERT
	// (frozen, no JS). It nests an island (InnerBadge) that DOES self-hydrate.
	import InnerBadge from '$lib/playground/InnerBadge.svelte' with { hydrate: 'load' };

	let frozen = $state(0);
</script>

<div
	class="widget"
	data-frozen-report
	style="max-width: 100%; margin-top: 0.875rem; background: var(--bg-sunken); border-style: dashed;"
>
	<span class="widget-label">frozen lake · 0 KB JS</span>
	<p class="widget-meta" data-frozen-static style="margin-top: 0;">
		This markup is server-rendered and left untouched. Its button never increments.
	</p>
	<button type="button" data-frozen-btn onclick={() => (frozen += 1)}>
		inert button · {frozen}
	</button>

	<div class="lake-inner">
		<span class="widget-meta">island authored inside the lake (self-hydrates):</span>
		<InnerBadge />
	</div>
</div>

<style>
	.lake-inner {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	button {
		height: 30px;
		padding-inline: 0.75rem;
		border-radius: var(--r-sm);
		border: 1px solid var(--line-strong);
		background: var(--bg-raised);
		color: var(--text-faint);
		font: 500 0.75rem/1 var(--font-body);
		cursor: not-allowed;
	}
</style>
