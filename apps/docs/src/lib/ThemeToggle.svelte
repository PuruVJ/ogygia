<script lang="ts">
	// Site theme cycler — auto → light → dark. Sets `data-theme` on <html> (the theme.css contract) and
	// persists to `og-theme` (the SAME key the layout no-flash script + the Observatory preview read). An
	// island (imported `with { wake: 'load' }`): under csr=false the onclick wires at hydrate. Its icon
	// syncs from the saved value on mount, and it reacts to the OS scheme changing while in auto.
	let theme = $state<'system' | 'light' | 'dark'>('system');

	$effect(() => {
		try {
			const t = localStorage.getItem('og-theme');
			theme = t === 'light' || t === 'dark' ? t : 'system';
		} catch {
			/* private mode */
		}
	});

	function cycle() {
		theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
		const root = document.documentElement;
		try {
			if (theme === 'system') {
				localStorage.removeItem('og-theme');
				root.removeAttribute('data-theme');
			} else {
				localStorage.setItem('og-theme', theme);
				root.setAttribute('data-theme', theme);
			}
		} catch {
			/* private mode */
		}
	}
</script>

<button type="button" class="theme-toggle" onclick={cycle} aria-label="cycle theme: auto, light, dark" title="Theme: {theme}">
	<span aria-hidden="true">{theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐'}</span>
</button>

<style>
	.theme-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg-raised);
		color: var(--text-dim);
		font-size: 0.95rem;
		line-height: 1;
		cursor: pointer;
	}
	.theme-toggle:hover {
		color: var(--text);
		border-color: var(--line-strong);
	}
</style>
