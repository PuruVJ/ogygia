<script lang="ts">
	import newsreaderItalicUrl from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2?url';
	import fontsMonoUrl from '../fonts-mono.css?url';
	import '../fonts.css';
	import '../app.css';
	import '$lib/styles/site-chrome.css';
	// The WHOLE site chrome — homepage and docs alike — DOGFOODS the pharos `Shell`, in the site's
	// own skin (never pharos theme.css). An empty `header` snippet removes the top header, so the
	// floating sidebar panel is the chrome: brand row (`side` snippet), search, theme toggle, and the
	// docs nav — exactly the shape the bespoke SideNav had, now rendered by the Shell's built-ins.
	import Shell from 'ogygia/pharos/shell';
	import 'ogygia/pharos/shell.css'; // layout FORM only (@layer pharos — the unlayered skin wins)
	import '$lib/styles/shell-skin.css'; // the site's LOOK on the .ph-* hooks
	import Logo from '$lib/Logo.svelte';
	import * as ogygia from 'ogygia';
	import { page } from '$app/state';
	import { meta } from '$lib/docs.remote';

	let { children } = $props();

	// `/demo/*` routes are standalone canvases (embedded in docs via <iframe>) — no site chrome.
	const bare = page.url.pathname.startsWith('/demo/');

	// The leak-free shell bundle (nav + switcher) — on the homepage the slug is empty, which resolves
	// the same docs tree the old SideNav showed there. csr=false → every nav is a fresh SSR pass, so a
	// top-level await is current per page.
	const shellMeta = bare ? null : await meta(page.params.slug ?? '');

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

{#if bare}
	{@render children()}
{:else}
	<!-- body is preload=off; the chrome opts hover back in so docs links warm on hover -->
	<div data-sveltekit-preload-data="hover">
		<Shell meta={shellMeta!} base="/docs" title="ogygia" header={null}>
			{#snippet side()}
				<a class="doc-brand" href="/" aria-label="ogygia home">
					<Logo size={22} decorative />
					<span class="doc-brand-word">ogygia</span>
				</a>
				<a
					class="doc-gh"
					href="https://github.com/PuruVJ/ogygia"
					target="_blank"
					rel="noreferrer"
					aria-label="GitHub repository"
				>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z" /></svg>
				</a>
			{/snippet}
			{@render children()}
		</Shell>
	</div>
{/if}

<style>
	/* The panel's brand row — logo + wordmark left, GitHub right (the old SideNav's top). */
	:global(.doc-brand) {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		color: var(--text);
		text-decoration: none;
	}
	:global(.doc-brand-word) {
		font: 600 1.05rem/1 var(--font-display);
		letter-spacing: -0.01em;
	}
	:global(.doc-gh) {
		margin-left: auto;
		display: inline-flex;
		color: var(--text-faint);
		text-decoration: none;
	}
	:global(.doc-gh:hover) {
		color: var(--text);
	}
</style>
