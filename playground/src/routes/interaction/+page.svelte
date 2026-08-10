<script lang="ts">
	// wake:'interaction' — the island sleeps until someone uses it. First click is captured,
	// the island hydrates, and the click replays so it counts. Typing before hydration survives.
	import InteractionCounter from '$lib/InteractionCounter.svelte' with { wake: 'interaction' };
	// A load island on the same page proves interaction chunks are NOT what loads at start.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	// Interaction × crossed children: the page composes an interaction island from the outside.
	// The synthesized-children entry rides the interaction schedule; the waking toggle click
	// replays exactly once against the crossed content.
	import CardInteraction from '$lib/CardShell.svelte' with { wake: 'interaction' };
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>Interaction islands</h1>
<p data-static-shell>The island below ships no JS until you click, focus, or type into it.</p>

<Counter label="eager" start={0} />
<InteractionCounter />

<div data-ix-card>
	<CardInteraction title="ix">
		<p data-ix-child>crossed child inside an interaction island</p>
	</CardInteraction>
</div>
