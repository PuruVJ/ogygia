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
	import 'ogygia/pharos/theme.css'; // design language (tokens + element styles, incl. .ph-body + code)
	import 'ogygia/pharos/shell.css'; // shell layout (header + sidebar + content grid + mobile chrome)
	import { page } from '$app/state';
	import { meta } from '$lib/docs.remote';

	let { children } = $props();

	// The leak-free shell bundle (nav + switcher) for the current page. csr=false → top-level await ok.
	const shellMeta = await meta(page.params.slug ?? '');
</script>

<Shell meta={shellMeta} base="/docs" title="ogygia">
	{#snippet actions()}
		<a
			class="doc-gh"
			href="https://github.com/PuruVJ/ogygia"
			target="_blank"
			rel="noreferrer"
			aria-label="GitHub repository">GitHub ↗</a
		>
	{/snippet}
	{@render children()}
</Shell>

<style>
	:global(.doc-gh) {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--ph-text-dim);
		text-decoration: none;
	}
	:global(.doc-gh:hover) {
		color: var(--ph-text);
	}
</style>
