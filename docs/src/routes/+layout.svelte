<script lang="ts">
	import '../fonts.css';
	import '../app.css';
	import { OgygiaRouter } from 'ogygia';
	import SideNav from '$lib/SideNav.svelte' with { hydrate: 'load' };

	let { children } = $props();
</script>

<OgygiaRouter />
<SideNav />
{@render children()}
