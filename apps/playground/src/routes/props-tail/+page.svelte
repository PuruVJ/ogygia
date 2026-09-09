<script lang="ts">
	// PROPS AFTER THE CONTENT (e2e/props-tail.spec.ts): every island's props sidecar is emitted at
	// the end of the body, keyed by fingerprint — never next to the island. Two identical islands
	// share one sidecar; a kept island crosses an SPA navigation with its props pushed from the tail.
	import Tally from '$lib/props-tail/Tally.svelte' with { wake: 'load' };
	import Keeper from '$lib/props-tail/Keeper.svelte' with { wake: 'load', keep: 'tally-keeper' };
</script>

<h1 data-static-shell>props tail — page A</h1>
<p><a href="/props-tail/b" data-to-b>to page B</a></p>

<Keeper page="A" />

<Tally label="twin" start={10} />
<Tally label="twin" start={10} />
<Tally label="solo" start={20} />

<p data-after-islands>content after the islands</p>
