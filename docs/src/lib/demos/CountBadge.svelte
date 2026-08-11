<script lang="ts">
	// A `region: 'raw'` component: server-rendered HTML, no client JS. It reads server state, so the
	// same call address re-renders different content each time the state moves.
	import { readBadgeCount } from './badge-count';
</script>

<strong class="count-badge" data-badge>{readBadgeCount()}</strong>

<style>
	.count-badge {
		font: 700 2rem/1 var(--font-mono, monospace);
		font-variant-numeric: tabular-nums;
	}
</style>
