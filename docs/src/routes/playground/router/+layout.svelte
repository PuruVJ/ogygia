<script lang="ts">
	// A sub-section under the always-on <ClientRouter/> (rendered in the docs root layout). These
	// links are same-origin, so the router intercepts them: it swaps the body, merges the head, and
	// runs a View Transition. Islands on the incoming page connect; islands on the outgoing page
	// disconnect.
	let { children } = $props();
</script>

<main class="shell docs-main">
	<span class="eyebrow">ClientRouter</span>
	<nav class="pg-subnav" aria-label="Router demo">
		<a href="/playground/router" data-rlink="hub">Hub</a>
		<a href="/playground/router/a" data-rlink="a">Page A</a>
		<a href="/playground/router/b" data-rlink="b">Page B</a>
		<a href="/playground/router/mpa" data-sveltekit-reload data-rlink="mpa">MPA page</a>
	</nav>

	{@render children()}
</main>

<style>
	.pg-subnav {
		display: flex;
		flex-wrap: wrap;
		gap: 1.25rem;
		margin: 1rem 0 2rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--line);
	}
	.pg-subnav a {
		font: 500 0.8125rem/1 var(--font-mono);
		color: var(--text-dim);
	}
	.pg-subnav a:hover {
		color: var(--accent);
	}
</style>
