<script lang="ts">
	/**
	 * The /docs chrome — DOGFOODS the pharos `Shell`. The sidebar, header, ⌘K search, theme toggle,
	 * mobile bottom-bar + sheet, skip link, roving-focus sidebar, and `#ph-main` landmark all come
	 * from Shell; there is no bespoke SideNav here. Leak-free: the corpus lives in `docs.server.ts`;
	 * we pull only the shell bundle over the wire via the `meta` remote and hand it to `<Shell {meta}>`.
	 *
	 * Styling is opt-in — the two pharos stylesheets give the design language + the shell layout.
	 */
	import Shell from 'ogygia/pharos/shell';
	// UNSTYLED components + our own skin — the customization ladder's CSS rung. shell.css is layout
	// only; the LOOK stays the site's own (NOT pharos theme.css): shell-skin.css paints the chrome
	// (floating sidebar panel, header, search, sheet) from the docs tokens, and pharos-docs.css
	// (imported by the doc route) paints the `.ph-*` doc body the same as it always was.
	import 'ogygia/pharos/shell.css';
	import '$lib/styles/shell-skin.css';
	import { page } from '$app/state';
	import { meta } from '$lib/docs.remote';
	import Logo from '$lib/Logo.svelte';

	let { children } = $props();

	// The leak-free shell bundle (nav + switcher) for the current page. csr=false → top-level await ok.
	const shellMeta = await meta(page.params.slug ?? '');
</script>

<!-- NO top header — an EMPTY `header` snippet removes it (snippet presence is the config), and the
     floating panel becomes the whole chrome: search + theme render in-panel, `side` is the brand row. -->
<Shell meta={shellMeta} base="/docs" title="ogygia">
	{#snippet header()}{/snippet}
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

<style>
	/* The panel's brand row — the old SideNav's top: logo + wordmark left, GitHub right. */
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
