<script lang="ts">
	import PermalinkHeading from '$lib/PermalinkHeading.svelte';
	import OnDemandHost from '$lib/playground/OnDemandHost.svelte' with { hydrate: 'load' };
	import CodeBlock from '$lib/CodeBlock.svelte';
	import PageHead from '$lib/PageHead.svelte';

	let { data }: { data: import('./$types').PageData } = $props();
</script>

<PageHead
	title="Client-only lazy mount · Playground"
	description="Dynamic import() of a regular Svelte component from inside an island — not an island boundary."
/>

<main class="shell docs-main">
	<section>
		<span class="eyebrow">pattern</span>
		<div class="section-header">
			<PermalinkHeading id="on-demand">Client-only lazy mount</PermalinkHeading>
			<p class="section-lede">
				Need a chunk that only downloads after a click? Keep a small host island, then
				<code>await import('./Comp.svelte')</code> with <strong>no</strong> region attributes.
				What you get is a regular component in that island’s tree — not a second island.
			</p>
		</div>

		<div class="prose od-prose">
			<p>
				<code>import(mod, &#123; with: &#123; hydrate: 'load' &#125;&#125;)</code> is a
				<strong>build error</strong>: Vite strips those attributes, runtimes reject unknown keys,
				and there is no SSR shell to hydrate anyway. Islands stay on static
				<code>import X from '…' with &#123; hydrate &#125;</code>.
			</p>
			<p>
				Plain dynamic import inside an island is normal Svelte: Vite code-splits the module; after
				the promise resolves you render <code>&lt;Comp /&gt;</code>. No ogygia region, no custom
				element for the lazy piece — just client JS.
			</p>
		</div>

		<div class="od-demo">
			<OnDemandHost />
		</div>

		<PermalinkHeading id="authoring" level={3} class="doc-subhead">Authoring</PermalinkHeading>
		<CodeBlock html={data.lazyClientMountHtml} />
	</section>
</main>

<style>
	.od-prose {
		margin-bottom: 1.75rem;
	}
	.od-demo {
		margin-bottom: 1.5rem;
	}
	.doc-subhead {
		margin: 0 0 0.75rem;
		font: 600 1.125rem/1.35 var(--font-body);
		letter-spacing: -0.01em;
		color: var(--text);
	}
</style>
