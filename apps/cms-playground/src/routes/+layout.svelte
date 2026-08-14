<script lang="ts">
	// The same Calypso shell the filesystem playground dogfoods — pointed at a CMS-backed site.
	import Calypso from 'ogygia/pharos/calypso';
	import 'ogygia/pharos/theme.css';
	import 'ogygia/pharos/calypso.css';
	import { site } from '$lib/cms';
	let { children } = $props();
</script>

<Calypso {site} base="" title="cms playground">
	{@render children()}
</Calypso>
