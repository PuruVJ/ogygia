<script lang="ts">
	// An intentionally EXTREMELY heavy SSR page — no islands, everything renders inline on the
	// server so the profiler attributes the cost to each component by name. This is the route to
	// point ogygia/profiler at:  /__profiler → "Profile one page" → /heavy
	import PrimeSieve from './PrimeSieve.svelte';
	import HeavyTable from './HeavyTable.svelte';
	import Fractal from './Fractal.svelte';
	import MarkdownishBlock from './MarkdownishBlock.svelte';

	// tunables — bump these to make a single render take longer
	const primeRuns = [350_000, 450_000, 550_000];
</script>

<svelte:head>
	<meta name="ogygia-router" content="plain" />
	<title>Heavy SSR page</title>
</svelte:head>

<main class="heavy">
	<h1 data-static-shell>Heavy SSR page</h1>
	<p data-static-shell>
		Four expensive component families rendered inline on the server: a CPU prime sieve, an
		800-row formatted table, an exponential recursive tree, and a regex-heavy text transform.
		Every millisecond here is real SSR time the profiler can localize.
	</p>

	<section>
		<h2>CPU: prime sieves</h2>
		{#each primeRuns as limit (limit)}
			<PrimeSieve {limit} />
		{/each}
	</section>

	<section>
		<h2>Text: regex transform</h2>
		<MarkdownishBlock paragraphs={600} />
	</section>

	<section>
		<h2>Recursion: fractal tree (3^7 nodes)</h2>
		<div class="fractal-wrap">
			<Fractal depth={7} fanout={3} />
		</div>
	</section>

	<section>
		<h2>List: 800-row formatted table</h2>
		<HeavyTable rows={800} seed={987654} />
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #fafaf8;
	}
	.heavy {
		max-width: 70rem;
		margin: 0 auto;
		padding: 2rem 1.25rem 6rem;
		font-family: system-ui, sans-serif;
		color: #1a202c;
	}
	.heavy h2 {
		margin: 2rem 0 0.5rem;
		font-size: 1rem;
		border-bottom: 1px solid #e2e8f0;
		padding-bottom: 0.25rem;
	}
	.fractal-wrap {
		max-height: 22rem;
		overflow: auto;
		border: 1px solid #e2e8f0;
		border-radius: 6px;
		padding: 6px;
	}
</style>
