<script lang="ts">
	// e2e/dom-ownership: an island that server-renders a third-party widget two ways, both of which
	// Svelte's hydration never walks into — inside `{@html}`, and as a custom element with static
	// children. The compiler stamps both hosts `data-og-opaque`; the widget (defined by the page after
	// the runtime boots, before this island wakes) reworks its own light DOM, and the wake must leave
	// every node of it in place.
	const markup = '<x-guided-e2e data-variant="html"><form class="a"><input name="q" /></form><i class="b"></i></x-guided-e2e>';
	const mixed = '<x-guided-e2e data-variant="mixed"><form class="a"><input name="q" /></form><i class="b"></i></x-guided-e2e>';
	let clicks = $state(0);
</script>

<section data-ownership>
	<button data-wake onclick={() => (clicks += 1)}>clicks {clicks}</button>
	<div class="widget-host">{@html markup}</div>
	<x-guided-e2e data-variant="static"><form class="a"><input name="q" /></form><i class="b"></i></x-guided-e2e>
	<!-- an {@html} beside walked content: the third shape -->
	<div class="widget-mixed"><h3>search ({clicks})</h3>{@html mixed}</div>
</section>
