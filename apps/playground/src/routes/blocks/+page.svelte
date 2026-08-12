<script lang="ts">
	// The stress case for registry CSS: this page imports NO block component — the tree, the
	// registry, and the render all come from the server pass via `data.page.body`. Every block's
	// stylesheet must therefore travel with the rendered HTML (nothing here statically links it).
	import { Region } from 'ogygia';
	let { data } = $props();
</script>

<h1 data-static-shell>Blocks (server-only registry)</h1>
<p data-static-shell>
	Rendered from <code>pages/landing.json</code> through a registry only the server imports.
</p>

<Region of={data.page.body} />
