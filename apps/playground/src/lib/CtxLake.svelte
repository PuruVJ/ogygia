<script lang="ts">
	// A frozen lake (used with `wake: 'none'`). Its own code ships in no client chunk, but the
	// context reader authored INSIDE it emits its own `<ogygia-region hydrate>` and self-hydrates.
	// When it wakes, its get() must still reach the page provider that sits ABOVE the lake in the DOM.
	import CtxReader from '$lib/CtxReader.svelte' with { wake: 'load' };

	const FROZEN_MARKER = 'FROZEN_CTX_LAKE_MARKER_7b21';
</script>

<div class="lake" data-ctx-lake>
	<p data-ctx-lake-static>frozen ({FROZEN_MARKER})</p>
	<CtxReader label="in-lake" />
</div>
