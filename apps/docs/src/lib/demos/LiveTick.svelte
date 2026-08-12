<script lang="ts">
	// A STATIC live partial (`partial: 'static'`) — ships no client JS. The server renders it fresh
	// each tick; the runtime morphs the new HTML into the existing DOM in place.
	let { n, at }: { n: number; at: string } = $props();
	const time = $derived(at.slice(11, 19));
</script>

<div class="live-tick">
	<strong class="live-tick-n">tick #{n}</strong>
	<span class="live-tick-at">{time}</span>
</div>

<style>
	.live-tick {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.65rem 0.85rem;
		border: 1px solid var(--line-strong, currentColor);
		border-radius: 8px;
		font-variant-numeric: tabular-nums;
	}
	.live-tick-at {
		opacity: 0.7;
	}
</style>
