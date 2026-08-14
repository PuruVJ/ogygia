<script lang="ts">
	// The same Shell the filesystem playground dogfoods — pointed at a CMS-backed site.
	import Shell from 'ogygia/pharos/shell';
	import 'ogygia/pharos/theme.css';
	import 'ogygia/pharos/shell.css';
	import { site } from '$lib/cms';
	let { children } = $props();
</script>

<Shell {site} base="" title="cms playground">
	{@render children()}
</Shell>
