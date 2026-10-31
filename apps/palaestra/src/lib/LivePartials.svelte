<script lang="ts">
	// Island host for live partials. It never imports LiveStat / StatBadge — it renders whatever the
	// live query streams. `.current` holds the latest tick; `<Region>` swaps/morphs/keep-alives it.
	import { Region } from 'ogygia';
	import { liveStat, liveBadge } from '$lib/live-partials.remote';

	const stat = liveStat();
	const badge = liveBadge();
</script>

<div class="live-partials">
	<section data-live-interactive>
		<h3>Interactive (keep-alive)</h3>
		{#if stat.current}
			<Region of={stat.current} />
		{:else}
			<p data-live-pending>connecting…</p>
		{/if}
	</section>

	<section data-live-static>
		<h3>Static (morph in place)</h3>
		{#if badge.current}
			<Region of={badge.current} />
		{:else}
			<p data-badge-pending>connecting…</p>
		{/if}
	</section>
</div>
