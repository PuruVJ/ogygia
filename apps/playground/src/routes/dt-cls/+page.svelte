<script lang="ts">
	// THE SHIFT LAB (devtools answer key). Plain: an image with no size set loads above a block of
	// text and pushes it down. `?hole`: a hole whose answer is far taller than its fallback swaps in
	// above the same text. Each must be named as the cause of the worst burst of shifts.
	import { page } from '$app/state';
	import TallHole from '$lib/dtcls/TallHole.svelte' with { render: 'deferred' };
	const hole = page.url.searchParams.has('hole');
</script>

<h1>shift lab</h1>
{#if hole}
	<TallHole>
		{#snippet ogygiaFallback()}<p data-cls-fallback>loading…</p>{/snippet}
	</TallHole>
{:else}
	<!-- (no width or height: its space is only made when it arrives) -->
	<img data-cls-img src="/dt-lcp/hero.svg?quick" alt="no size set" />
{/if}
<div data-cls-text style="font-size: 22px; line-height: 1.6; max-width: 1100px">
	{#each Array(14) as _, i (i)}<p>Paragraph {i + 1}: text below the plant, pushed down when it lands. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>{/each}
</div>
