<script lang="ts">
	import newsreaderItalicUrl from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2?url';
	import fontsMonoUrl from '../fonts-mono.css?url';
	import '../fonts.css';
	import '../app.css';
	import '$lib/styles/site-chrome.css';
	import { OgygiaRouter } from 'ogygia';
	import SideNav from '$lib/SideNav.svelte' with { hydrate: 'load' };

	let { children } = $props();

	// Inline loader: layout is csr=false so module-side client imports never run.
	// Schedules JetBrains after window load / idle; ui-monospace covers hero code until then.
	const loadMonoScript = `(function(){var h=${JSON.stringify(fontsMonoUrl)};function l(){var e=document.createElement("link");e.rel="stylesheet";e.href=h;document.head.appendChild(e)}function s(){"requestIdleCallback"in window?requestIdleCallback(l,{timeout:2500}):setTimeout(l,1)}document.readyState==="complete"?s():window.addEventListener("load",s,{once:!0})})();`;
</script>

<svelte:head>
	<link
		rel="preload"
		href={newsreaderItalicUrl}
		as="font"
		type="font/woff2"
		crossorigin="anonymous"
	/>
	{@html `<script>${loadMonoScript}</script>`}
</svelte:head>

<OgygiaRouter />
<!-- body is preload=off; sidenav opts hover back in so playground/docs links warm on hover -->
<div data-ogygia-persist="site-sidenav" data-sveltekit-preload-data="hover">
	<SideNav />
</div>
{@render children()}
