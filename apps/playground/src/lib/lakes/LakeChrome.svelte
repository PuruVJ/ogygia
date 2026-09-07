<script lang="ts">
	// Site chrome as a LAKE (`wake: 'none'` at the import site, routes/lake-kit): frozen server HTML
	// carrying a `wake: 'load'` island (the header) and a server island (the greeting hole). Its own
	// code ships in NO client chunk — on a csr=true page too, where Kit hydrates the document AROUND
	// it and the wrapper adopts this element verbatim (e2e/lake-kit.spec.ts).
	import ChromeHeader from '../ChromeHeader.svelte' with { wake: 'load' };
	import Greeting from '../Greeting.svelte' with { render: 'deferred' };

	// Distinctive string the lake-kit suite greps for — it must appear in NO emitted client chunk.
	const LAKE_CHROME_MARKER = 'LAKE_CHROME_CODE_MARKER_5c1e';
</script>

<div data-lake-chrome>
	<p data-lake-static>lake chrome ({LAKE_CHROME_MARKER})</p>
	<ChromeHeader />
	<Greeting salutation="Hello">
		{#snippet ogygiaFallback()}<p data-lake-fallback>loading greeting…</p>{/snippet}
	</Greeting>
</div>
