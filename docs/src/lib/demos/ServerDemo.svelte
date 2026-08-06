<script lang="ts">
	import type { Snippet } from 'svelte';
	import '$lib/styles/demo-block.css';
	import '$lib/styles/widget.css';

	let {
		title = "defer: 'load' · ServerGreeting.svelte",
		codeHtml,
		live
	}: {
		title?: string;
		codeHtml: string;
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
			{@html codeHtml}
		</div>
		<div class="demo-preview" data-state="hydrated">
			<span class="preview-marker"><i></i>server HTML swapped in</span>
			<div class="preview-stage">
				{@render live()}
			</div>
		</div>
	</div>
</figure>
