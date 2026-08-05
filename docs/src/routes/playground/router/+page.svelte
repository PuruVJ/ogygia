<script lang="ts">
	import RouteProbe from '$lib/playground/RouteProbe.svelte' with { hydrate: 'load' };
	import PageHead from '$lib/PageHead.svelte';
</script>

<PageHead
	title="SPA router · Playground"
	description="OgygiaRouter client-side swaps with view transitions, persist chrome, link prefetch, and MPA handoff."
/>

<h2 style="view-transition-name: pg-router-title;">SPA router</h2>
<div class="prose" style="margin-bottom: 2rem;">
	<p>
		<code>&lt;OgygiaRouter /&gt;</code> is rendered in this site's root layout, so navigation between
		these pages is a client-side swap: the body is replaced, the head is merged, and a View
		Transition plays where supported. The heading morphs across pages because it carries a shared
		<code>view-transition-name</code>.
	</p>
	<p>
		The <strong>persist probe</strong> above the page content sits in
		<code>data-ogygia-persist="router-demo-chrome"</code> in this section's layout. Click +1, then
		go to Page A and back — mount id and click count stay put. The <strong>route probe</strong>
		below remounts on every navigation (fresh mount id); that is the default for islands outside
		persist chrome.
	</p>
</div>

<RouteProbe />

<h3 class="doc-subhead">Link prefetch</h3>
<div class="prose">
	<p>
		This site sets <code>data-sveltekit-preload-data="off"</code> on <code>&lt;body&gt;</code>, so
		nothing prefetches by default. The links below opt specific triggers back in. The router warms
		its page-HTML cache on the declared trigger; a prefetched page swaps in on click with no second
		request.
	</p>
</div>

<ul class="pg-prefetch">
	<li>
		<span data-sveltekit-preload-data="hover">
			<a href="/playground/router/a" data-prefetch-hover>Page A</a>
		</span>
		<span class="pg-note">— warms on hover</span>
	</li>
	<li>
		<a href="/playground/router/b" data-sveltekit-preload-data="tap" data-prefetch-tap>Page B</a>
		<span class="pg-note">— warms on press</span>
	</li>
	<li>
		<a href="/playground/router/a" data-sveltekit-preload-code="eager" data-prefetch-eager>
			Page A (eager)
		</a>
		<span class="pg-note">— warmed immediately on load</span>
	</li>
</ul>

<style>
	.pg-prefetch {
		margin: 1rem 0 0;
		padding-left: 1.1rem;
		display: grid;
		gap: 0.5rem;
		color: var(--text-dim);
		font-size: 0.9375rem;
	}
	.pg-note {
		color: var(--text-faint);
		font: 400 0.75rem/1 var(--font-mono);
	}
</style>
