<script lang="ts">
	// The SPA router (+ view transitions) is global — enabled by the ogygia() vite plugin, no
	// component to render. `/plain` opts OUT of view transitions per-page via a meta tag.
	// `base` prefixes every internal link so the app is correct under a non-root `paths.base`
	// (and prerenders cleanly there); it is `''` by default, so normal runs are unchanged.
	import { base } from '$app/paths';
	let { children } = $props();
</script>

<nav>
	<a href="{base}/">Home</a>
	<a href="{base}/about">About</a>
	<a href="{base}/data">Data</a>
	<a href="{base}/server">Server</a>
	<a href="{base}/nested">Nested</a>
	<a href="{base}/ctx-nav" data-ctx-nav-link>Ctx nav</a>
	<a href="{base}/static">Prerendered</a>
	<a href="{base}/forms">Forms</a>
	<a href="{base}/dashboard/orders">Dashboard</a>
	<a href="{base}/nav-batch" data-nav-batch-link data-ogygia-speculate="off">nav-batch</a>
	<a href="{base}/ooo" data-ooo-link data-ogygia-speculate="off">OOO</a>
	<a href="{base}/plain">Plain (no view transitions)</a>
</nav>
<hr />
{@render children()}
