<script lang="ts">
	import RouteProbe from '$lib/playground/RouteProbe.svelte' with { hydrate: 'load' };
</script>

<h2 style="view-transition-name: pg-router-title;">SPA router</h2>
<div class="prose" style="margin-bottom: 2rem;">
	<p>
		<code>&lt;ClientRouter /&gt;</code> is rendered in this site's root layout, so navigation between
		these pages is a client-side swap: the body is replaced, the head is merged, and a View
		Transition plays where supported. The heading morphs across pages because it carries a shared
		<code>view-transition-name</code>.
	</p>
	<p>
		The probe island below reads the current path from <code>$app/state</code> and stamps a fresh
		mount id. Navigate to Page A and back: the path updates and the mount id changes, because
		islands remount on every navigation — there is no cross-navigation island state.
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
