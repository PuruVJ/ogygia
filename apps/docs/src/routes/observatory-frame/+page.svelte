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

		/* ── BOUNDARY LENS (x-ray) — the parent's x-ray mode adds `.lens` to #obs-app. This overlays the
		   REAL, live islands: they stay interactive and wake on their real schedule; the tint just draws
		   the boundaries. Keys off the runtime's own attributes (data-kind stamped from data-obs-*, `wake`,
		   and data-hydrated = the true woke signal). Text colour is theme-aware (var(--obs-text)). ── */
		#obs-app.lens ogygia-region {
			display: block;
			position: relative;
			margin: 22px 0 10px;
			padding: 8px 10px;
			border-radius: 7px;
			color: var(--obs-text);
			outline: 2px solid var(--lens, #14b8a6);
			background: color-mix(in srgb, var(--lens, #14b8a6) 8%, transparent);
		}
		#obs-app.lens ogygia-region[data-kind='island'] {
			--lens: #14b8a6;
		}
		#obs-app.lens ogygia-region[data-kind='server hole'],
		#obs-app.lens ogygia-region[data-kind='live'] {
			--lens: #8b5cf6;
		}
		#obs-app.lens ogygia-region::before {
			content: attr(data-name) ' · ' attr(data-kind);
			position: absolute;
			top: -18px;
			left: -2px;
			padding: 1px 7px;
			border-radius: 5px 5px 0 0;
			background: var(--lens, #14b8a6);
			color: #04121a;
			font: 700 10px/1.5 ui-monospace, Menlo, monospace;
			white-space: nowrap;
		}
		/* cold: hasn't hydrated yet (an interaction/visible island still asleep) — dashed + dimmed. */
		#obs-app.lens ogygia-region[data-obs-real-island]:not([data-hydrated]) {
			outline-style: dashed;
			outline-color: color-mix(in srgb, var(--lens, #14b8a6) 55%, transparent);
			background: color-mix(in srgb, var(--obs-muted) 8%, transparent);
		}
		#obs-app.lens ogygia-region[data-obs-real-island]:not([data-hydrated]) > * {
			opacity: 0.5;
			filter: grayscale(0.4);
		}
		#obs-app.lens ogygia-region[data-obs-real-island]:not([data-hydrated])::after {
			content: '💤 asleep · wakes on ' attr(wake);
			position: absolute;
			top: -18px;
			right: -2px;
			padding: 1px 7px;
			border-radius: 5px 5px 0 0;
			background: color-mix(in srgb, var(--obs-muted) 30%, transparent);
			color: var(--obs-muted);
			font: 10px/1.5 ui-monospace, Menlo, monospace;
			white-space: nowrap;
		}
		/* hot: hydrated — solid, lit, stamped with +Xms since render + the bytes it shipped. */
		#obs-app.lens ogygia-region[data-obs-real-island][data-hydrated] {
			box-shadow: 0 0 0 4px color-mix(in srgb, var(--lens, #14b8a6) 18%, transparent);
			transition: box-shadow 0.25s ease;
		}
		#obs-app.lens ogygia-region[data-obs-real-island][data-hydrated][data-woke-ms]::after {
			content: '⚡ woke +' attr(data-woke-ms) 'ms' ' · ' attr(data-bytes) ' B JS';
			position: absolute;
			top: -18px;
			right: -2px;
			padding: 1px 7px;
			border-radius: 5px 5px 0 0;
			background: color-mix(in srgb, var(--lens, #14b8a6) 25%, var(--obs-bg));
			color: var(--lens, #14b8a6);
			font: 10px/1.5 ui-monospace, Menlo, monospace;
			white-space: nowrap;
		}
	}
</style>
