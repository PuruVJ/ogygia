<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Region, type RegionValue } from 'ogygia';
	import '$lib/styles/demo-block.css';
	import '$lib/styles/widget.css';
	import '$lib/styles/feel.css';

	let {
		title,
		code,
		live,
		frozen,
		stack = false,
		onLabel = 'hydrated',
		offLabel = 'static · 0 KB JS'
	}: {
		title: string;
		/** A same-pass region — or the baked html STRING when the caller is an island (a region
		 *  can't cross a captured-prop boundary; its html can). */
		code: RegionValue | string;
		live: Snippet;
		frozen: Snippet;
		stack?: boolean;
		onLabel?: string;
		offLabel?: string;
	} = $props();

	let jsOn = $state(true);
</script>

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
			{#if typeof code === 'string'}
				{@html code}
			{:else}
				<Region of={code} />
			{/if}
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
