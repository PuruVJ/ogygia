<script lang="ts">
	// Dogfood the Calypso shell. Header extras are a SNIPPET — it renders in the desktop header and,
	// because the compiler makes a forwarded snippet PORTABLE, crosses into the mobile island's sheet
	// footer and comes alive there.
	import Calypso from 'ogygia/pharos/calypso';
	// Styling is OPT-IN: Calypso ships no CSS, so we import the pharos look explicitly.
	// FORM + LANGUAGE compose: calypso.css is the building blocks (layout only); the LANGUAGE is one
	// of nine zen-garden theme files, loaded via a swappable <link> (see <svelte:head>) so the
	// floating ThemePicker can switch skins at runtime. Thalassa is the default.
	// (The STOCK pair still works too: `import 'ogygia/pharos/theme.css'` BEFORE calypso.css.)
	import 'ogygia/pharos/calypso.css'; // the FORM: header + sidebar + content grid + mobile chrome
	import stock from 'ogygia/pharos/theme.css?url'; // the stock default language
	import thalassa from 'ogygia/pharos/themes/thalassa.css?url';
	import alexandria from 'ogygia/pharos/themes/alexandria.css?url';
	import pyros from 'ogygia/pharos/themes/pyros.css?url';
	import zephyros from 'ogygia/pharos/themes/zephyros.css?url';
	import selas from 'ogygia/pharos/themes/selas.css?url';
	import daidalos from 'ogygia/pharos/themes/daidalos.css?url';
	import kalliope from 'ogygia/pharos/themes/kalliope.css?url';
	import nephele from 'ogygia/pharos/themes/nephele.css?url';
	import ThemePicker from '$lib/ThemePicker.svelte' with { wake: 'load' };
	const themes = { thalassa, stock, alexandria, pyros, zephyros, selas, daidalos, kalliope, nephele };
	// Self-hosted variable fonts — the theme references Inter / JetBrains Mono; point its tokens at the
	// `@fontsource-variable` family names below.
	import '@fontsource-variable/inter';
	import '@fontsource-variable/jetbrains-mono';
	import { site } from '$lib/docs';
	let { children } = $props();
</script>

<svelte:head>
	<link id="pg-theme" rel="stylesheet" href={thalassa} />
</svelte:head>

<Calypso {site} base="" title="pharos playground">
	{#snippet actions()}
		<a class="pg-gh" href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer"
			>GitHub ↗</a
		>
	{/snippet}
	{@render children()}
</Calypso>
<ThemePicker {themes} />

<style>
	/* Stock-theme guard: it sets `display` on the mobile chrome; when swapped in AFTER calypso.css
	   via the theme link, re-assert the form's desktop visibility (unlayered wins over @layer). */
	@media (min-width: 901px) {
		:global(.ph-calypso .ph-bottombar),
		:global(.ph-calypso .ph-sheet),
		:global(.ph-calypso .ph-sheet-backdrop) {
			display: none;
		}
	}

	/* Unlayered → wins over `@layer pharos` — repoint the theme's font tokens at the loaded families. */
	:global(:root) {
		--ph-font: 'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
		--ph-mono: 'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
	}
	:global(.pg-gh) {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--ph-text-dim);
		text-decoration: none;
	}
	:global(.pg-gh:hover) {
		color: var(--ph-text);
	}
</style>
