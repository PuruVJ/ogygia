<script lang="ts">
	// The full cross-island composition stress case, all authored by the page and crossing into a
	// hydrate island: a captured host VALUE (who), a named snippet (header), a parameterized snippet
	// (row), and a NESTED ISLAND (Bumper) inside the children.
	import CardShell from '$lib/CardShell.svelte' with { wake: 'load' };
	import Bumper from '$lib/Bumper.svelte' with { wake: 'load' };

	const who = 'Ada';
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>Children passed into an island</h1>

<CardShell title="Everything">
	{#snippet header()}<em data-child-header>header for {who}</em>{/snippet}
	<p data-child-static>hello {who}</p>
	<Bumper start={5} />
	{#snippet row(item)}<li data-child-row>{item} · {who}</li>{/snippet}
</CardShell>

<!-- Same import, a SECOND call site with different children — proves per-call-site islands. -->
<CardShell title="Second">
	<p data-child-second>second card, {who}</p>
</CardShell>
