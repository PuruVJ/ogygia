<script lang="ts">
	// Nested islands + context. This is a hydrated island whose OWN source imports another context
	// reader as a `visible` island. The inner reader degrades to inline and hydrates WITH this outer
	// island. During that single hydrate CURRENT_REGION is this outer region, so the inner reader's
	// get() still walks up the DOM to the page provider — nesting must not break the context read.
	import CtxReader from '$lib/CtxReader.svelte' with { wake: 'visible' };

	let n = $state(0);
</script>

<div class="island" data-ctx-nest-outer>
	<button data-nest-btn onclick={() => (n += 1)}>outer {n}</button>
	<CtxReader label="nested-inner" />
</div>
