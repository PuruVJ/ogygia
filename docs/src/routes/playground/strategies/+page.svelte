<script lang="ts">
	import PermalinkHeading from '$lib/PermalinkHeading.svelte';
	// Each demo wrapper is imported AS an island with the strategy it demonstrates. The live/frozen
	// pair and the JS toggle live inside DemoBlock — flip the toggle to compare the hydrated UI with
	// the static HTML the server actually shipped.
	// Code is Shiki-highlighted at build (`strategiesPageSnippets` prerender RF) and passed as
	// string props — island chunks never import Shiki.
	import LoadDemo from '$lib/demos/LoadDemo.svelte' with { hydrate: 'load' };
	import IdleDemo from '$lib/demos/IdleDemo.svelte' with { hydrate: 'idle' };
	import VisibleDemo from '$lib/demos/VisibleDemo.svelte' with { hydrate: 'visible' };
	import MediaDemo from '$lib/demos/MediaDemo.svelte' with { hydrate: '(max-width: 600px)' };
	import PresetDemo from '$lib/playground/PresetDemo.svelte' with { preset: 'demo' };
	import PageHead from '$lib/PageHead.svelte';

	let { data }: { data: import('./$types').PageData } = $props();
</script>

<PageHead
	title="Strategies · Playground"
	description="Live hydrate strategies: load, idle, visible, media, and named presets — with JS-off toggles to see the shipped HTML."
/>

<main class="shell docs-main">
	<section>
		<span class="eyebrow">hydrate</span>
		<div class="section-header">
			<PermalinkHeading id="strategies">Hydration strategies</PermalinkHeading>
			<p class="section-lede">
				When the JavaScript arrives is the whole point of an island. These are real regions on
				this page. Each block ships static HTML first; the JS toggle shows exactly what the
				server sent before hydration took over.
			</p>
		</div>

		<div class="section-stack demo-section">
			<div class="strategy">
				<PermalinkHeading id="load" level={3}><code>hydrate: 'load'</code></PermalinkHeading>
				<div class="prose">
					<p>
						Hydrates as soon as the region's custom element connects, after DOM ready. Use it for
						the controls a page cannot function without. The JS-off side is the shipped HTML —
						present, styled, but inert.
					</p>
				</div>
				<LoadDemo codeHtml={data.loadCode} />
			</div>

			<div class="strategy">
				<PermalinkHeading id="idle" level={3}><code>hydrate: 'idle'</code></PermalinkHeading>
				<div class="prose">
					<p>
						Waits for <code>requestIdleCallback</code> (with a timeout fallback). The HTML is
						already there; only the listeners and reactive runtime wait for a quiet moment.
					</p>
				</div>
				<IdleDemo codeHtml={data.idleCode} />
			</div>

			<div class="strategy">
				<PermalinkHeading id="visible" level={3}><code>hydrate: 'visible'</code></PermalinkHeading>
				<div class="prose">
					<p>
						Gated on <code>IntersectionObserver</code>. Below-the-fold content stays SSR HTML until
						it approaches the viewport. A <code>visible.margin</code> pre-warms it slightly early.
					</p>
				</div>
				<div class="scroll-hint">Scroll until the visible block intersects the viewport.</div>
				<VisibleDemo codeHtml={data.visibleCode} />
			</div>

			<div class="strategy">
				<PermalinkHeading id="media" level={3}><code>hydrate: '(max-width: 600px)'</code></PermalinkHeading>
				<div class="prose">
					<p>
						Any media query is a strategy, resolved with <code>matchMedia</code>. On a wide window
						this stays static until you narrow it — that is the strategy working, not a broken
						preview. Mobile-only JS never loads on desktop.
					</p>
				</div>
				<MediaDemo codeHtml={data.mediaCode} />
			</div>

			<div class="strategy">
				<PermalinkHeading id="preset" level={3}><code>preset: 'demo'</code></PermalinkHeading>
				<div class="prose">
					<p>
						Option tuning cannot go on the import. It lives in plugin config, optionally behind a
						named preset. This block uses the <code>demo</code> preset from this site's vite config
						(<code>hydrate: 'visible'</code> with a <code>200px</code> margin).
					</p>
				</div>
				<PresetDemo codeHtml={data.presetCode} />
			</div>
		</div>
	</section>
</main>
