<script>
	/**
	 * Renders a route's layout chain around its page. `chain` is the layout components from OUTERMOST to
	 * innermost (app shell → section shell → …); each is an inert component that renders `{@render
	 * children()}` and may read `data` (the cascaded load data at that level). At the bottom the PAGE
	 * COMPONENT is rendered AS MARKUP (`<Page {...props} />`), not as a held region — so any import-
	 * attribute mark on it (`with { wake }`, `with { render: 'deferred' }`, `with { region: 'raw' }`,
	 * `with { keep }`) emits its shell exactly as it would at any other usage site. That is what makes
	 * page-level interactivity/deferral work: the router is a normal placement site for the component.
	 *
	 * `fallback` (a deferred page's loading placeholder) is provided as the component's reserved
	 * `ogygiaFallback` snippet — the router is the deferred page's use site, so it supplies the slot a
	 * deferred component would otherwise get from its `{#snippet ogygiaFallback()}` child.
	 *
	 * Server-rendered inside document(); the layouts and the page are real regions, so islands inside
	 * them wake and their CSS rides the response.
	 */
	let { chain, component: Page, props, data, fallback: Fallback } = $props();
</script>

{#snippet nest(i)}
	{#if i < chain.length}
		{@const Layout = chain[i]}
		<Layout {data}>{@render nest(i + 1)}</Layout>
	{:else if Fallback}
		<Page {...props}>
			{#snippet ogygiaFallback()}<Fallback {data} />{/snippet}
		</Page>
	{:else}
		<Page {...props} />
	{/if}
{/snippet}

{@render nest(0)}
