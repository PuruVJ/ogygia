<script lang="ts">
	// A homepage showcase tile: a highlighted code sample beside its live demo. The demo is passed
	// as a snippet so the island tag lives at the page's top level (marked imports can't take host
	// children) while this plain component just lays it out. Reuses the demo-block styling.
	import type { Snippet } from 'svelte';
	import { Region, type RegionValue } from 'ogygia';
	import '$lib/styles/demo-block.css';
	import '$lib/styles/widget.css';
	import '$lib/styles/feel.css';

	let {
		title,
		tag = '',
		marker = 'live island',
		offMarker = 'static · 0 KB JS',
		code,
		demo,
		frozen,
		stack = false
	}: {
		title: string;
		tag?: string;
		marker?: string;
		offMarker?: string;
		code: RegionValue;
		demo: Snippet;
		/** Optional server-rendered (no-JS) view. When present, a JS toggle appears. */
		frozen?: Snippet;
		stack?: boolean;
	} = $props();

	let jsOn = $state(true);
	const on = $derived(!frozen || jsOn);
</script>

<figure class="demo-block">
	<figcaption class="demo-header">
		<span class="demo-title">{title}</span>
		{#if tag}<code class="showcase-tag">{tag}</code>{/if}
		{#if frozen}
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
		{/if}
	</figcaption>
	<div class="demo-body" class:demo-body--stack={stack}>
		<div class="demo-code">
			<Region of={code} />
		</div>
		<div class="demo-preview" data-state={on ? 'hydrated' : 'static'}>
			<span class="preview-marker"><i></i>{on ? marker : offMarker}</span>
			<div class="preview-stage">
				{#if frozen}
					<div class="preview-live" class:is-hidden={!on}>
						{@render demo()}
					</div>
					<div class="preview-static" class:is-hidden={on}>
						{@render frozen()}
					</div>
				{:else}
					{@render demo()}
				{/if}
			</div>
		</div>
	</div>
</figure>

<style>
	.showcase-tag {
		font: 500 0.75rem/1 var(--font-mono);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent-deep) 22%, transparent);
		padding: 0.3rem 0.5rem;
		border-radius: 6px;
	}
</style>
