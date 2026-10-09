<script lang="ts">
	// The Observatory — ogygia's in-browser REPL. It runs the REAL transform (rolldown WASM oxc) +
	// svelte compile in a Web Worker, previews in an isolated iframe, and hydrates with the real
	// runtime. It's a `wake: 'load'` island (this route is csr=false; the machinery is browser-only).
	import { script } from 'ogygia';
	import Observatory from '$lib/Observatory.svelte' with { wake: 'load' };

	// This is a bare route (no DocsShell), so its no-flash theme must run here: set data-theme from the
	// active `og-theme` key before paint (same key the docs ThemeToggle + the preview iframe use).
	const noFlash = script((k) => {
		try {
			const t = localStorage.getItem(k);
			if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
		} catch (e) {
			/* private mode */
		}
	}, 'og-theme');
</script>

<svelte:head>
	<title>Observatory · ogygia</title>
	<meta name="description" content="The ogygia compiler, running live in your browser — edit a component and watch it become islands." />
	{@html noFlash}
</svelte:head>

<Observatory />
