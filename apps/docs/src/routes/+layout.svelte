<script lang="ts">
	import newsreaderItalicUrl from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2?url';
	import fontsMonoUrl from '../fonts-mono.css?url';
	import '../fonts.css';
	import '../app.css';
	import '$lib/styles/site-chrome.css';
	import * as ogygia from 'ogygia';
	import { page } from '$app/state';
	import SideNav from '$lib/SideNav.svelte' with { wake: 'load' };

	let { children } = $props();

	// `/demo/*` routes are standalone canvases (embedded in docs via <iframe>) — no site chrome.
	const bare = $derived(page.url.pathname.startsWith('/demo/'));
	// `/docs/*` brings its OWN chrome — the pharos Shell (see docs/+layout.svelte). Skip the bespoke
	// SideNav there so the two don't stack.
	const isDocs = $derived(page.url.pathname === '/docs' || page.url.pathname.startsWith('/docs/'));

	// No-flash theme: apply a saved forced theme before first paint. `ogygia.script` serializes
	// the self-contained function into a safe inline <script> (no `String.fromCharCode` gymnastics).
	const themeTag = ogygia.script(() => {
		try {
			const t = localStorage.getItem('ogygia-theme');
			if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
		} catch {
			/* private mode */
		}
	});

	// Deferred JetBrains Mono: load after window load / idle so ui-monospace covers hero code first.
	// The hashed URL is closed-over data, so it is passed as an arg (serialized for the inline script).
	const monoTag = ogygia.script(
		(href: string) => {
			const load = () => {
				const e = document.createElement('link');
				e.rel = 'stylesheet';
				e.href = href;
				document.head.appendChild(e);
			};
			const schedule = () =>
				'requestIdleCallback' in window
					? requestIdleCallback(load, { timeout: 2500 })
					: setTimeout(load, 1);
			document.readyState === 'complete'
				? schedule()
				: window.addEventListener('load', schedule, { once: true });
		},
		fontsMonoUrl
	);
</script>

<svelte:head>
	<link
		rel="preload"
		href={newsreaderItalicUrl}
		as="font"
		type="font/woff2"
		crossorigin="anonymous"
	/>
	{@html themeTag}
	{@html monoTag}
</svelte:head>

{#if !bare && !isDocs}
	<a class="skip-link" href="#main-content">Skip to content</a>
	<!-- body is preload=off; sidenav opts hover back in so playground/docs links warm on hover -->
	<div data-ogygia-keep="site-sidenav" data-sveltekit-preload-data="hover">
		<SideNav />
	</div>
{/if}
{@render children()}
