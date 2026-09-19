<script lang="ts">
	// The island that reads `$page` WHOLE (Object.keys over page.data): the build cannot pin its
	// keys, so the entire page.data ships as the seed — the "seed-large" shape. It also awaits a
	// REMOTE FUNCTION at the top level, so that call runs during the page's SSR (the "remote
	// functions" phase on the timeline).
	import { page } from '$app/state';
	import { stockSummary } from './hell.remote';
	const keys = Object.keys(page.data);
	const n = (page.data.catalog?.products?.length as number | undefined) ?? 0;
	const summary = await stockSummary();
	let tick = $state(0);
</script>

<p data-ticker>
	{n} products in {keys.length} data keys · {summary.low} low, {summary.out} out of stock · tick {tick}
	<button onclick={() => tick++}>+</button>
</p>
