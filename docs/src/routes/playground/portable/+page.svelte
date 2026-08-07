<script lang="ts">
	import PermalinkHeading from '$lib/PermalinkHeading.svelte';
	import CodeBlock from '$lib/CodeBlock.svelte';
	import PageHead from '$lib/PageHead.svelte';
	// Page-level island imports so each stays a real region (not nested inside another island).
	import PulseWidget from '$lib/playground/portable/PulseWidget.svelte' with { hydrate: 'load' };
	import TickerWidget from '$lib/playground/portable/TickerWidget.svelte' with { hydrate: 'load' };
	import NotchWidget from '$lib/playground/portable/NotchWidget.svelte' with { hydrate: 'load' };
	// Separate controls island: serializable props only — never constructors.
	import PortableControls from '$lib/playground/PortableControls.svelte' with { hydrate: 'load' };

	let { data }: { data: import('./$types').PageData } = $props();

	const registry = {
		pulse: PulseWidget,
		ticker: TickerWidget,
		notch: NotchWidget
	} as const;

	type WidgetKey = keyof typeof registry;

	const items: { key: WidgetKey; label: string }[] = [
		{ key: 'pulse', label: 'Pulse' },
		{ key: 'ticker', label: 'Ticker' },
		{ key: 'notch', label: 'Notch' }
	];

	const activeKey = $derived(
		(data.active in registry ? data.active : 'pulse') as WidgetKey
	);
	const Active = $derived(registry[activeKey]);
</script>

<PageHead
	title="Portable bindings · Playground"
	description="Marked imports are values — stash them in a dictionary or barrel, pick one, render with a capitalized binding tag."
/>

<main class="shell docs-main" data-portable-page>
	<section>
		<span class="eyebrow">ogygia 0.4</span>
		<div class="section-header">
			<PermalinkHeading id="portable">Portable island bindings</PermalinkHeading>
			<p class="section-lede">
				A marked <code>import … with &#123; hydrate &#125;</code> rewrites the binding itself into a
				portable island component. Put several in a dictionary or barrel, pick one into a capitalized
				binding, and render <code>&lt;Active /&gt;</code> — each stays a real region as long as the
				usage is at page level.
			</p>
		</div>

		<div class="prose portable-prose">
			<p>
				Do not pass constructors across an island boundary as props — they will not devalue. Keep a
				small controls island that only receives serializable labels and the active key, and navigate
				with <code>?widget=</code> links (works with JS off; the SPA router soft-navs when JS is on).
				Nesting an island import inside another island degrades to a shared interactive tree — these
				widgets are imported on the page shell so the selected one is a true region.
			</p>
		</div>

		<div class="portable-demo">
			<PortableControls active={activeKey} {items} />
			<div class="portable-slot" data-active={activeKey}>
				{#key activeKey}
					<Active />
				{/key}
			</div>
		</div>

		<PermalinkHeading id="authoring" level={3} class="doc-subhead">Authoring</PermalinkHeading>
		<CodeBlock html={data.portableBindingsHtml} />
	</section>
</main>

<style>
	.portable-prose {
		margin-bottom: 1.75rem;
	}
	.portable-demo {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		margin-bottom: 1.75rem;
	}
	.portable-slot {
		min-height: 9rem;
	}
	:global(.doc-subhead) {
		margin: 0 0 0.75rem;
		font: 600 1.125rem/1.35 var(--font-body);
		letter-spacing: -0.01em;
		color: var(--text);
	}
</style>
