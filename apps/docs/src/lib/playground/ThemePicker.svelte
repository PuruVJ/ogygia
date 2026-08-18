<script lang="ts">
	/**
	 * Playground-only dev tool: a floating picker that swaps the active ogygia THEME stylesheet at
	 * runtime (zen-garden style — one `<link id="pg-theme">` in the head, nine language files). An
	 * ISLAND (`wake:'load'`) so it re-hydrates per SPA nav and re-applies the saved choice. Built on
	 * Bits UI `Select` for real listbox semantics (keyboard nav, typeahead, ARIA).
	 */
	import { Select } from 'bits-ui';

	let { themes }: { themes: Record<string, string> } = $props();
	const KEY = 'pg-theme';
	const names = Object.keys(themes);

	let value = $state((typeof window !== 'undefined' && localStorage.getItem(KEY)) || 'thalassa');

	function apply(name: string) {
		const link = document.getElementById('pg-theme') as HTMLLinkElement | null;
		if (link && themes[name]) link.href = themes[name];
	}
	// Re-hydration after each SPA nav lands here — re-apply the saved skin over the SSR default.
	if (typeof window !== 'undefined' && themes[value]) apply(value);

	// Light/dark toggle — playground-only, and DELIBERATELY light/dark ONLY (no `system`) and
	// NON-persisting: it's a temporary preview inside the frame, so trying a palette here never
	// touches the visitor's saved theme.
	function pg_is_dark() {
		const t = document.documentElement.getAttribute('data-theme');
		if (t === 'dark') return true;
		if (t === 'light') return false;
		return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
	}
	let dark = $state(typeof window !== 'undefined' ? pg_is_dark() : false);
	function toggle_dark() {
		const root = document.documentElement;
		const flip = () => {
			dark = !dark;
			root.setAttribute('data-theme', dark ? 'dark' : 'light'); // no localStorage, on purpose
		};
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		const doc = document as unknown as {
			startViewTransition?: (cb: () => void) => { finished: Promise<void> };
		};
		if (doc.startViewTransition && !reduce) {
			root.setAttribute('data-ph-switching', '');
			const clear = () => root.removeAttribute('data-ph-switching');
			doc.startViewTransition(flip).finished.then(clear, clear);
		} else flip();
	}
</script>

<div class="pg-picker">
	<button
		type="button"
		class="pg-tt"
		aria-label="Preview light or dark"
		title="Light / dark (preview only)"
		onclick={toggle_dark}
	>
		{#if dark}
			<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
				><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg
			>
		{:else}
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"
				><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg
			>
		{/if}
	</button>
	<Select.Root
		type="single"
		bind:value
		onValueChange={(v) => {
			if (!v) return;
			localStorage.setItem(KEY, v);
			apply(v);
		}}
	>
		<Select.Trigger class="pg-pick-trigger" aria-label="Playground theme">
			<span class="pg-pick-label">theme</span>
			{value}
			<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
		</Select.Trigger>
		<Select.Portal>
			<Select.Content class="pg-pick-menu" sideOffset={8} align="end" strategy="fixed" hideWhenDetached={false}>
				<Select.Viewport>
					{#each names as t (t)}
						<Select.Item value={t} label={t}>
							{#snippet children({ selected })}
								<span class="pg-pick-opt" data-selected={selected || undefined}>{t}</span>
							{/snippet}
						</Select.Item>
					{/each}
				</Select.Viewport>
			</Select.Content>
		</Select.Portal>
	</Select.Root>
</div>

<style>
	.pg-picker {
		position: fixed;
		right: 1rem;
		bottom: calc(var(--og-bar-h, 3.5rem) + 0.75rem);
		z-index: 300;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.3rem;
		border: 1px solid var(--og-line, #ccc);
		border-radius: 999px;
		background: var(--og-bg, #fff);
		box-shadow: var(--og-shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.2));
	}
	@media (min-width: 901px) {
		.pg-picker {
			bottom: 1rem;
		}
	}
	.pg-tt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 999px;
		background: none;
		color: var(--og-text, #111);
		cursor: pointer;
	}
	.pg-tt:hover {
		background: var(--og-bg-sunken, rgba(0, 0, 0, 0.06));
	}
	.pg-picker :global(.pg-pick-trigger) {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.6rem;
		border: 0;
		border-radius: 999px;
		background: none;
		font: 600 0.75rem/1 var(--og-mono, monospace);
		letter-spacing: 0.06em;
		color: var(--og-text, #111);
		cursor: pointer;
	}
	.pg-picker :global(.pg-pick-label) {
		text-transform: uppercase;
		color: var(--og-text-faint, #888);
	}
	/* portaled to <body> — style via :global, painted with the ACTIVE theme's tokens */
	:global(.pg-pick-menu) {
		z-index: 310;
		min-width: 10rem;
		padding: 0.3rem;
		border: 1px solid var(--og-line, #ccc);
		border-radius: var(--og-radius, 10px);
		background: var(--og-bg, #fff);
		box-shadow: var(--og-shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.25));
		font: 500 0.8rem/1.2 var(--og-mono, monospace);
		color: var(--og-text, #111);
	}
	:global(.pg-pick-opt) {
		display: block;
		padding: 0.4rem 0.55rem;
		border-radius: var(--og-radius-sm, 6px);
		cursor: pointer;
	}
	:global([data-highlighted] > .pg-pick-opt) {
		background: var(--og-bg-raised, #eee);
	}
	:global(.pg-pick-opt[data-selected]) {
		color: var(--og-accent-text, #0a7d55);
		font-weight: 700;
	}
</style>
