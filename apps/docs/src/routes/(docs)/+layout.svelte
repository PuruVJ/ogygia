<script lang="ts">
	import newsreaderItalicUrl from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2?url';
	// The roman display face (the `ogygia` wordmark uses it) is `font-display: optional`, so on a cold
	// first load it fell back to thick Georgia on some pages and thin Newsreader on others. Preload it
	// too, so the wordmark is the SAME thin serif everywhere.
	import newsreaderRomanUrl from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?url';
	import fontsMonoUrl from '../../fonts-mono.css?url';
	import '../../fonts.css';
	import '../../app.css';
	import '$lib/styles/site-chrome.css';
	// The WHOLE site chrome — homepage and docs alike — DOGFOODS the ogygia `Shell`, in the site's
	// own skin (never ogygia theme.css). An empty `header` snippet removes the top header, so the
	// floating sidebar panel is the chrome: brand row (`side` snippet), search, theme toggle, and the
	// docs nav — exactly the shape the bespoke SideNav had, now rendered by the Shell's built-ins.
	import DocsShell from 'ogygia/content/docs-shell';
	import 'ogygia/content/shell.css'; // layout FORM only (@layer ogygia — the unlayered skin wins)
	import '$lib/styles/shell-skin.css'; // the site's LOOK on the .ph-* hooks
	import SiteHeader from '$lib/SiteHeader.svelte';
	import * as ogygia from 'ogygia';
	import { page } from '$app/state';
	import { meta } from '$lib/docs.remote';

	let { children } = $props();

	// `/demo/*` routes are standalone canvases (embedded in docs via <iframe>) — no site chrome.
	const bare = page.url.pathname.startsWith('/demo/');
	// The homepage is a marketing page: full-viewport, no docs sidebar — its own slim top-nav instead.
	const isHome = page.url.pathname === '/';
	// The Observatory: the SAME site top-nav (MarketingHeader) as the homepage, then the full-viewport
	// REPL fills the rest (the REPL carries its own secondary toolbar).
	const isObservatory = page.url.pathname.startsWith('/observatory');
	// Breadcrumb after the wordmark: `ogygia │ Docs` / `ogygia │ Observatory`; nothing on the homepage.
	const section = isHome ? null : isObservatory ? 'Observatory' : 'Docs';

	// The leak-free shell bundle (nav + switcher) — docs pages only. Skipped on the homepage (no
	// sidebar) and bare canvases, which also saves the nav-tree fetch there. csr=false → every nav is
	// a fresh SSR pass, so a top-level await is current per page.
	const shellMeta = bare || isHome || isObservatory ? null : await meta(page.params.slug ?? '');

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
	<link
		rel="preload"
		href={newsreaderRomanUrl}
		as="font"
		type="font/woff2"
		crossorigin="anonymous"
	/>
	{@html themeTag}
	{@html monoTag}
</svelte:head>

{#if bare}
	{@render children()}
{:else if isObservatory}
	<!-- Shared site header (same as home + docs), then the full-viewport REPL fills the rest. -->
	<div class="obs-page" data-sveltekit-preload-data="hover">
		<SiteHeader section="Observatory" />
		{@render children()}
	</div>
{:else if isHome}
	<!-- Marketing homepage: the shared header (no breadcrumb) + full-width content, no docs sidebar.
	     The header is FIXED, so the content clears its height. -->
	<div class="home-page" data-sveltekit-preload-data="hover">
		<SiteHeader section={null} />
		{@render children()}
	</div>
{:else}
	<!-- Docs: the SAME shared header on top (DocsShell's `header` snippet), so the sidebar carries only
	     the nav — `tools={null}` drops the panel-chrome search/theme, now in the header. -->
	<div data-sveltekit-preload-data="hover">
		<DocsShell meta={shellMeta!} base="/docs" home="/" title="ogygia" tools={null}>
			{#snippet header()}
				<SiteHeader section="Docs" />
			{/snippet}
			{@render children()}
		</DocsShell>
	</div>
{/if}

<style>
	/* The header is fixed (out of flow) so the elastic overscroll can't drag it — the homepage content
	   clears its height. (Docs clears it via .og-cframe; the Observatory keeps its header in-flow.) */
	:global(.home-page) {
		padding-top: 3.5rem;
	}

	/* Observatory page: site header as a top bar (in flow, not sticky), REPL fills the rest. */
	:global(.obs-page) {
		height: 100dvh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	:global(.obs-page .site-nav) {
		position: static;
	}
	:global(.obs-page > ogygia-region) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
</style>
