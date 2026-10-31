<script lang="ts">
	import Tally from '$lib/props-tail/Tally.svelte' with { wake: 'load' };
	import Keeper from '$lib/props-tail/Keeper.svelte' with { wake: 'load', keep: 'tally-keeper' };
</script>

<h1 data-static-shell>props tail — page B</h1>
<p><a href="/props-tail" data-to-a>to page A</a></p>

<Keeper page="B" />

<Tally label="b-only" start={30} />

<p data-after-islands>content after the islands</p>
