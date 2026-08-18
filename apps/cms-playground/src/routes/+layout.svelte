<script lang="ts">
	// The same Shell the filesystem playground dogfoods — pointed at a CMS-backed site.
	import DocsShell from 'ogygia/content/docs-shell';
	import 'ogygia/content/theme.css';
	import 'ogygia/content/shell.css';
	import { cms } from '$lib/cms';
	let { children } = $props();
</script>

<DocsShell {site} base="" title="cms playground">
	{@render children()}
</DocsShell>
