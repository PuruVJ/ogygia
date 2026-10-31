<script lang="ts">
	// The CPU-heavy components from /heavy, rendered on a page that ALSO did slow I/O in its load.
	import PrimeSieve from '../heavy/PrimeSieve.svelte';
	import HeavyTable from '../heavy/HeavyTable.svelte';
	import Fractal from '../heavy/Fractal.svelte';
	import MarkdownishBlock from '../heavy/MarkdownishBlock.svelte';

	let { data } = $props();
	const primeRuns = [300_000, 450_000];
</script>

<svelte:head>
	<meta name="ogygia-router" content="plain" />
	<title>Mixed bench: I/O + CPU</title>
</svelte:head>

<main class="mx">
	<h1>Mixed bench</h1>
	<p class="mx-note">
		This page's <code>load</code> waited ~2.4s on a DB-like timer, a file read, and two upstream
		calls, then the render burns CPU on a prime sieve, an 800-row table, a fractal, and a regex
		pass. One report shows <strong>both</strong>: Waiting by function for the load, CPU / Components
		for the render.
	</p>

	<section class="mx-io">
		<h2>load results (the waiting part)</h2>
		<ul>
			<li>db query: {data.db.rows} ms</li>
			<li>manifest: {data.manifestChars} chars</li>
			{#each data.feeds as feed (feed.name)}
				<li>{feed.name}: upstream {feed.ms} ms</li>
			{/each}
		</ul>
	</section>

	<section>
		<h2>CPU: prime sieves</h2>
		{#each primeRuns as limit (limit)}
			<PrimeSieve {limit} />
		{/each}
	</section>

	<section>
		<h2>Text: regex transform</h2>
		<MarkdownishBlock paragraphs={500} />
	</section>

	<section>
		<h2>Recursion: fractal tree</h2>
		<div class="mx-fractal"><Fractal depth={6} fanout={3} /></div>
	</section>

	<section>
		<h2>List: 800-row formatted table</h2>
		<HeavyTable rows={800} seed={424242} />
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #fafaf8;
	}
	.mx {
		max-width: 70rem;
		margin: 0 auto;
		padding: 2rem 1.25rem 6rem;
		font-family: system-ui, sans-serif;
		color: #1a202c;
	}
	.mx h2 {
		margin: 2rem 0 0.5rem;
		font-size: 1rem;
		border-bottom: 1px solid #e2e8f0;
		padding-bottom: 0.25rem;
	}
	.mx-note {
		color: #5c574a;
		max-width: 46rem;
	}
	.mx-io ul {
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
	}
	.mx-fractal {
		max-height: 20rem;
		overflow: auto;
		border: 1px solid #e2e8f0;
		border-radius: 6px;
		padding: 6px;
	}
</style>
