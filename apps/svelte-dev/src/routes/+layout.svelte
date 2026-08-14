<script lang="ts">
	// Fonts + design system, imported as JS (Vite resolves each reliably — a CSS `@import` chain here
	// gets eager-globbed by ogygia's dev-HMR bridge and one bad import breaks the whole thing).
	import '@fontsource/fira-sans/400.css';
	import '@fontsource/fira-sans/500.css';
	import '@fontsource/dm-serif-display/400.css';
	import '@fontsource/dm-serif-display/400-italic.css';
	import '@fontsource/eb-garamond/400.css';
	import '@fontsource/eb-garamond/400-italic.css';
	import '@fontsource/eb-garamond/500.css';
	import '@fontsource/fira-mono/400.css';
	import '@fontsource/atkinson-hyperlegible/400.css';
	import '@fontsource/atkinson-hyperlegible/700.css';
	import '$lib/styles/tokens.css';
	import '$lib/styles/base.css';
	import '$lib/styles/content.css';
	import '$lib/styles/twoslash.css';

	import * as ogygia from 'ogygia';
	import { preference, preference_switch } from 'ogygia';
	// Island: the header carries client state now (mobile bottom-bar hide-on-scroll, the drawer).
	import Header from '$lib/Header.svelte' with { wake: 'load' };

	let { children } = $props();

	// The JS↔TS code preference (js_to_ts variants bind to it). head() applies the saved choice
	// before paint; preference_switch() is ONE delegated handler wiring every variant-switcher button.
	const codeLang = preference({ name: 'code-language', values: ['ts', 'js'], default: 'ts' });

	// No-flash theme + font: apply the saved `.dark`/`.light` and `font-*` classes before first
	// paint. No theme class → the tokens follow the system preference.
	const themeTag = ogygia.script(() => {
		try {
			const t = localStorage.getItem('sk-theme');
			if (t === 'dark') document.documentElement.classList.add('dark');
			else if (t === 'light') document.documentElement.classList.add('light');
			const f = localStorage.getItem('svelte:font');
			if (f === 'boring') document.documentElement.classList.add('font-boring');
		} catch {
			/* private mode */
		}
	});

	// One delegated handler for the header's theme toggle — survives SPA body-swaps, no island needed.
	const toggleTag = ogygia.script(() => {
		document.addEventListener('click', function (e) {
			const target = e.target as Element | null;
			const btn = target && target.closest ? target.closest('[data-theme-toggle]') : null;
			if (!btn) return;
			const el = document.documentElement;
			const isDark =
				el.classList.contains('dark') ||
				(!el.classList.contains('light') && matchMedia('(prefers-color-scheme: dark)').matches);
			const next = isDark ? 'light' : 'dark';
			el.classList.remove('dark', 'light');
			el.classList.add(next);
			try {
				localStorage.setItem('sk-theme', next);
			} catch {
				/* private mode */
			}
		});
	});
</script>

<svelte:head>
	{@html themeTag}
	{@html toggleTag}
	{@html codeLang.head()}
	{@html preference_switch()}
</svelte:head>

<Header />
{@render children()}
