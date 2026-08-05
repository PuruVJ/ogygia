<figure class="demo-block">
	<figcaption class="demo-header">
		<span class="demo-title">{title}</span>
		<label class="js-toggle">
			<span class="js-toggle-label">JS</span>
			<button
				type="button"
				class="js-toggle-track"
				role="switch"
				aria-checked={jsOn}
				aria-label="Toggle JavaScript for this demo"
				onclick={() => (jsOn = !jsOn)}
			>
				<span class="js-toggle-thumb"></span>
			</button>
		</label>
	</figcaption>

	<div class="demo-body" class:demo-body--stack={stack}>
		<div class="demo-code">
			<pre><code>{@html codeHtml}</code></pre>
		</div>
		<div class="demo-preview" data-state={jsOn ? 'hydrated' : 'static'}>
			<span class="preview-marker">
				<i></i>
				{jsOn ? onLabel : offLabel}
			</span>
			<div class="preview-stage">
				<div class="preview-live" class:is-hidden={!jsOn}>
					{@render live()}
				</div>
				<div class="preview-static" class:is-hidden={jsOn}>
					{@render frozen()}
				</div>
			</div>
		</div>
	</div>
</figure>

<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		codeHtml,
		live,
		frozen,
		stack = false,
		onLabel = 'hydrated',
		offLabel = 'static · 0 KB JS'
	}: {
		title: string;
		codeHtml: string;
		live: Snippet;
		frozen: Snippet;
		stack?: boolean;
		onLabel?: string;
		offLabel?: string;
	} = $props();

	let jsOn = $state(true);
</script>
