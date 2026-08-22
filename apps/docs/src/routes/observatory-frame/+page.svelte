<script>
	// The frame's harness is an island (client JS under csr=false): it receives the app from the parent
	// over postMessage, links + injects it, and this page's runtime hydrates it in FULL isolation.
	import { script } from 'ogygia';
	import Harness from '$lib/observatory-frame/Harness.svelte' with { wake: 'load' };
	import '$lib/observatory-canvas.css'; // gentle, overridable native-element defaults (shared with the in-page preview)

	// No-flash theme: read the shared `og-theme` (same key + storage the docs ThemeToggle uses) BEFORE
	// paint. Same-origin → the iframe shares localStorage with the host, so it tracks the docs theme.
	const noFlash = script((k) => {
		try {
			const t = localStorage.getItem(k);
			if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
		} catch (e) {
			/* private mode */
		}
	}, 'og-theme');
</script>

<svelte:head>{@html noFlash}</svelte:head>

<Harness />
<div id="obs-app" class="og-canvas"></div>

<style>
	/* Global (this page IS the iframe document): theme tokens + gentle app defaults. Light on bare
	   :root, dark under prefers-color-scheme (guarded so an explicit choice wins) + [data-theme].
	   Mirrors the ogygia content theme.css contract (data-theme + the `og-theme` storage key). */
	:global {
		:root {
			--obs-bg: #ffffff;
			--obs-panel: #e6ece9;
			--obs-text: #121a16;
			--obs-muted: #4a5c52;
			--obs-border: #d5e0da;
			--obs-accent: #0f7a4f;
			color-scheme: light;
		}
		:root:not([data-theme='light']) {
			@media (prefers-color-scheme: dark) {
				--obs-bg: #101713;
				--obs-panel: #060907;
				--obs-text: #e6eee9;
				--obs-muted: #8fa398;
				--obs-border: #1c2620;
				--obs-accent: #6fe3b0;
				color-scheme: dark;
			}
		}
		:root[data-theme='dark'] {
			--obs-bg: #101713;
			--obs-panel: #060907;
			--obs-text: #e6eee9;
			--obs-muted: #8fa398;
			--obs-border: #1c2620;
			--obs-accent: #6fe3b0;
			color-scheme: dark;
		}

		html,
		body {
			margin: 0;
			padding: 0;
			font:
				14px/1.6 system-ui,
				-apple-system,
				'Segoe UI',
				sans-serif;
			color: var(--obs-text);
			background: var(--obs-bg);
		}
		#obs-app {
			padding: 16px 18px;
		}
		/* Native-element defaults live in the shared $lib/observatory-canvas.css (.og-canvas), imported above. */
	}
</style>
