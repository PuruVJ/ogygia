<script lang="ts">
	/**
	 * Theme cycler — system → light → dark → system. Sets `data-theme` on the root element (the
	 * theme.css contract) and persists to localStorage.
	 *
	 * An ISLAND (a shell imports it `with { wake: 'load' }`): the `onclick` handler is wired at hydrate
	 * time and re-wired every SPA nav, so it never goes stale. (A one-shot inline `script()` would,
	 * since inline scripts don't re-run on a body-swap.)
	 *
	 * Pair with a no-flash head script that applies the stored theme before first paint (a shell like
	 * the Shell includes it; standalone users add it once in their layout):
	 * `{@html script((k) => { try { var t = localStorage.getItem(k); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) {} }, 'ph-theme')}`
	 */

	let {
		key = 'ph-theme',
		label = 'Theme'
	}: {
		/** localStorage key (default `ph-theme`) — match your no-flash head script. */
		key?: string;
		label?: string;
	} = $props();

	function cycle() {
		const root = document.documentElement;
		const flip = () => {
			const cur = root.getAttribute('data-theme');
			const next = cur === null ? 'light' : cur === 'light' ? 'dark' : null;
			if (next) root.setAttribute('data-theme', next);
			else root.removeAttribute('data-theme');
			try {
				if (next) localStorage.setItem(key, next);
				else localStorage.removeItem(key);
			} catch {
				/* private mode */
			}
		};
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		// View Transitions give ONE smooth cross-fade of the whole page between palettes. Under it,
		// `data-ph-switching` mutes every element's own color transition so the live DOM snaps to the
		// new theme in a single frame — the fade is the only motion. No support / reduced motion → a
		// plain instant flip.
		const doc = document as unknown as {
			startViewTransition?: (cb: () => void) => { finished: Promise<void> };
		};
		if (doc.startViewTransition && !reduce) {
			root.setAttribute('data-ph-switching', '');
			const clear = () => root.removeAttribute('data-ph-switching');
			doc.startViewTransition(flip).finished.then(clear, clear);
		} else {
			flip();
		}
	}
</script>

<!-- All three icons render; the (scoped, self-contained) style shows the one matching root state. -->
<button type="button" class="ph-theme-toggle" aria-label={label} title={label} onclick={cycle}>
	<svg class="ph-tt ph-tt-system" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
		<rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" />
	</svg>
	<svg class="ph-tt ph-tt-light" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
		<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
	</svg>
	<svg class="ph-tt ph-tt-dark" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
	</svg>
</button>

<style>
	/* Self-contained: works with OR without theme.css (colors inherit; sizing is intrinsic). */
	.ph-theme-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 8px;
		background: none;
		color: inherit;
		cursor: pointer;
	}
	.ph-tt {
		display: none;
	}
	:global(:root:not([data-theme])) .ph-tt-system,
	:global(:root[data-theme='light']) .ph-tt-light,
	:global(:root[data-theme='dark']) .ph-tt-dark {
		display: inline;
	}
</style>
