<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<meta name="ogygia-router" content="plain" />
	<title>Slow I/O page</title>
</svelte:head>

<main class="io">
	<h1>Slow I/O page</h1>
	<p class="io-note">
		This page's <code>load</code> waits ~3.5s across a fake DB query, a file read, and three
		upstream calls, all awaited one after another. Almost no CPU. Point the profiler at
		<code>/slow-io</code> and read <strong>Waiting by function</strong>.
	</p>

	<ul class="io-list">
		<li>db query: {data.db.rows} ms</li>
		<li>manifest: {data.manifestChars} chars</li>
		{#each data.feeds as feed (feed.name)}
			<li>{feed.name}: upstream {feed.ms} ms</li>
		{/each}
	</ul>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #fafaf8;
	}
	.io {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.25rem 4rem;
		font-family: system-ui, sans-serif;
		color: #1a202c;
	}
	.io-note {
		color: #5c574a;
	}
	.io-list {
		font-family: ui-monospace, monospace;
		font-size: 0.9rem;
	}
</style>
