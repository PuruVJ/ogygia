<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Region, type RegionValue } from 'ogygia';
	import '$lib/styles/demo-block.css';
	import '$lib/styles/widget.css';

	let {
		title = "render: 'deferred' · ServerGreeting.svelte",
		code,
		live
	}: {
		title?: string;
		code: RegionValue;
		live: Snippet;
	} = $props();
</script>

<figure class="demo-block">
	<figcaption class="demo-header">
		<span class="demo-title">{title}</span>
		<span class="caption">0 KB component JS</span>
	</figcaption>
	<div class="demo-body demo-body--stack">
		<div class="demo-code">
			<Region of={code} />
		</div>
		<div class="demo-preview" data-state="hydrated">
			<span class="preview-marker"><i></i>server HTML swapped in</span>
			<div class="preview-stage">
				{@render live()}
			</div>
		</div>
	</div>
</figure>
