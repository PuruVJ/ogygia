<script lang="ts">
	// PRELOADS for the devtools answer key. The planted one has no `crossorigin`: a `fetch()` cannot
	// use it, so the browser downloads the file again. The decoy's `crossorigin="anonymous"` matches
	// a same-origin `fetch()` and is used. The devtools must name planted.json, never decoy.json.
	const fetch_both = `<script>fetch('/dt-preload/data/planted').then((r) => r.json());fetch('/dt-preload/data/decoy').then((r) => r.json());<\/script>`;
</script>

<svelte:head>
	<link rel="preload" as="fetch" href="/dt-preload/data/planted" />
	<link rel="preload" as="fetch" href="/dt-preload/data/decoy" crossorigin="anonymous" />
</svelte:head>

<h1>preload lab</h1>
<p>Two preloads, both fetched by the page: one the browser can use, one it cannot.</p>
{@html fetch_both}
