<script lang="ts">
	// Site chrome as a LAKE (`wake: 'none'` at the import site, routes/lake-kit): frozen server HTML
	// carrying a `wake: 'load'` island (the header) and a server island (the greeting hole). Its own
	// code ships in NO client chunk — on a csr=true page too, where Kit hydrates the document AROUND
	// it and the wrapper adopts this element verbatim (e2e/lake-kit.spec.ts).
	import ChromeHeader from '../ChromeHeader.svelte' with { wake: 'load' };
	import Greeting from '../Greeting.svelte' with { render: 'deferred' };
	// A hole that always keepFallback()s, whose fallback holds an interaction island (lake-kit e2e).
	// `wake: 'load'` makes the hole an AWAKE ancestor — the case where a flattened fallback island
	// could never wake (a kept hole has no phase-2 hydration of its own).
	import Kept from '../Kept.svelte' with { render: 'deferred', wake: 'load' };
	import KeptFallbackButton from '../KeptFallbackButton.svelte' with { wake: 'interaction' };
	// An island WITH PROPS inside the lake: its props sidecar rides the document tail, which the
	// handle must still emit on a csr=true page (it once skipped the whole tail there, and an island
	// like this hydrated with `undefined` props and died — lake-kit e2e).
	import Counter from '../Counter.svelte' with { wake: 'load' };

	// Distinctive string the lake-kit suite greps for — it must appear in NO emitted client chunk.
	const LAKE_CHROME_MARKER = 'LAKE_CHROME_CODE_MARKER_5c1e';
</script>

<div data-lake-chrome>
	<p data-lake-static>lake chrome ({LAKE_CHROME_MARKER})</p>
	<ChromeHeader />
	<Greeting salutation="Hello">
		{#snippet ogygiaFallback()}<p data-lake-fallback>loading greeting…</p>{/snippet}
	</Greeting>
	<Kept>
		{#snippet ogygiaFallback()}<KeptFallbackButton />{/snippet}
	</Kept>
	<div data-lake-props-island>
		<Counter start={7} label="in-lake" />
	</div>
</div>

<style>
	/* The lake's SCOPED CSS rides its island-entry chunk, which a lake never loads. The compiler
	   side-effect-imports it into the client host graph instead so Kit links it on csr=false AND
	   csr=true pages. The e2e reads this distinctive value back to prove that link holds (a lake in
	   a layout that also serves a csr=true page once dropped it — the fouc-css/link_virtual gap). */
	[data-lake-static] {
		letter-spacing: 7px;
	}
</style>
