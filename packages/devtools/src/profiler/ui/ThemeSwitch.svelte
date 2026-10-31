<script lang="ts">
	/**
	 * Theme switch — system / light / dark, written to `data-theme` on <html> and remembered under
	 * `og-profiler-theme`. The same mechanism ogygia's own docs use (data-theme + a stored key), so
	 * the profiler reads in the app's design language either way. A `wake:'load'` island; it re-applies
	 * the saved choice on hydration and flips with a view transition when the browser supports one.
	 */
	type Mode = 'system' | 'light' | 'dark';
	const KEY = 'og-profiler-theme';
	const NEXT: Record<Mode, Mode> = { system: 'light', light: 'dark', dark: 'system' };
	const ICON: Record<Mode, string> = { system: '◐', light: '☀', dark: '☾' };

	let mode = $state<Mode>('system');
	if (typeof window !== 'undefined') {
		try {
			const saved = localStorage.getItem(KEY) as Mode | null;
			mode = saved === 'light' || saved === 'dark' ? saved : 'system';
		} catch {
			/* private mode */
		}
		apply(mode);
	}

	function apply(m: Mode) {
		const root = document.documentElement;
		if (m === 'system') root.removeAttribute('data-theme');
		else root.setAttribute('data-theme', m);
		try {
			if (m === 'system') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, m);
		} catch {
			/* private mode */
		}
	}
	function cycle() {
		const next = NEXT[mode];
		const flip = () => {
			mode = next;
			apply(next);
		};
		const doc = document as unknown as { startViewTransition?: (cb: () => void) => void };
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		if (doc.startViewTransition && !reduce) doc.startViewTransition(flip);
		else flip();
	}
</script>

<button class="theme" onclick={cycle} title="Theme: {mode} (click to change)" aria-label="theme: {mode}">
	<span class="ic" aria-hidden="true">{ICON[mode]}</span>
	<span class="lbl">{mode}</span>
</button>

<style>
	.theme {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: none;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: 7px 10px;
		color: var(--text-dim);
		cursor: pointer;
		font-size: 12.5px;
		text-transform: capitalize;
	}
	.theme:hover {
		border-color: var(--accent-line);
		color: var(--text);
		background: var(--bg-hover);
	}
	.ic {
		font-size: 14px;
		color: var(--accent);
	}
</style>
