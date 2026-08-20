<script lang="ts">
	// The LEAN shape: this layout stays a normal (non-island) csr=false layout. Its script runs on the
	// SERVER only — which is fine, because everything here is server-computable: the template vars and
	// the setContext calls (drop-in from ogygia, so a page marker seeds child islands). The ONLY thing
	// that must run in the browser — the side effects — lives in the headless <BootEffects> island.
	import { setContext } from 'ogygia';
	import BootEffects from '$lib/BootEffects.svelte' with { wake: 'load' };

	let { data, children } = $props();

	// A template var computed in the script (like currentDir / isPreferenceCenter in x.svelte).
	const currentDir = data?.rtl ? 'rtl' : 'ltr';
	setContext('currentDir', currentDir);

	// Only the plain slice the side effects need crosses into the island (no promises, no stores).
	const plain = { rtl: data.rtl, appName: data.appName };
</script>

<BootEffects data={plain} />

<header data-chrome>Header · dir={currentDir} · app={data?.appName}</header>
{@render children()}
<footer data-chrome>Footer</footer>
