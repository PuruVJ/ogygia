<script lang="ts">
	import type { Component } from 'svelte';
	import Inner from './Inner.svelte' with { wake: 'load' };
	import { blocks } from './registry';

	// a CMS-container shape: the block is looked up in a registry at render time
	const Block = blocks.inner as Component<Record<string, unknown>>;
</script>

<!-- The OUTER island (e2e/nested-css): placed with `wake: 'interaction'`, so it stays asleep until
     clicked. Both inner islands render inside it, nested; their sheets must already be on the page. -->
<section data-nc-outer>
	<button data-nc-wake>wake</button>
	<Inner label="direct inner" />
	<Block label="registry inner" />
</section>
