<script lang="ts">
	import '../fonts.css';
	import '../app.css';
	import '$lib/styles/site-chrome.css';
	import { OgygiaRouter } from 'ogygia';
	import SideNav from '$lib/SideNav.svelte' with { hydrate: 'load' };

	let { children } = $props();
</script>

<OgygiaRouter />
<!-- body is preload=off; sidenav opts hover back in so playground/docs links warm on hover -->
<div data-ogygia-persist="site-sidenav" data-sveltekit-preload-data="hover">
	<SideNav />
</div>
{@render children()}
