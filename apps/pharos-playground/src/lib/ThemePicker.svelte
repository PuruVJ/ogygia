<script lang="ts">
	/**
	 * Playground-only dev tool: a floating picker that swaps the active pharos THEME stylesheet at
	 * runtime (zen-garden style — one `<link id="pg-theme">` in the head, nine language files). An
	 * ISLAND (`wake:'load'`) so it re-hydrates per SPA nav and re-applies the saved choice. Built on
	 * Bits UI `Select` for real listbox semantics (keyboard nav, typeahead, ARIA).
	 */
	import { Select } from 'bits-ui';
	import { ThemeToggle } from 'ogygia/pharos';

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
</script>

<div class="pg-picker">
	<ThemeToggle />
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
		bottom: calc(var(--ph-bar-h, 3.5rem) + 0.75rem);
		z-index: 300;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.3rem;
		border: 1px solid var(--ph-line, #ccc);
		border-radius: 999px;
		background: var(--ph-bg, #fff);
		box-shadow: var(--ph-shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.2));
	}
	@media (min-width: 901px) {
		.pg-picker {
			bottom: 1rem;
		}
	}
	.pg-picker :global(.pg-pick-trigger) {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.6rem;
		border: 0;
		border-radius: 999px;
		background: none;
		font: 600 0.75rem/1 var(--ph-mono, monospace);
		letter-spacing: 0.06em;
		color: var(--ph-text, #111);
		cursor: pointer;
	}
	.pg-picker :global(.pg-pick-label) {
		text-transform: uppercase;
		color: var(--ph-text-faint, #888);
	}
	/* portaled to <body> — style via :global, painted with the ACTIVE theme's tokens */
	:global(.pg-pick-menu) {
		z-index: 310;
		min-width: 10rem;
		padding: 0.3rem;
		border: 1px solid var(--ph-line, #ccc);
		border-radius: var(--ph-radius, 10px);
		background: var(--ph-bg, #fff);
		box-shadow: var(--ph-shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.25));
		font: 500 0.8rem/1.2 var(--ph-mono, monospace);
		color: var(--ph-text, #111);
	}
	:global(.pg-pick-opt) {
		display: block;
		padding: 0.4rem 0.55rem;
		border-radius: var(--ph-radius-sm, 6px);
		cursor: pointer;
	}
	:global([data-highlighted] > .pg-pick-opt) {
		background: var(--ph-bg-raised, #eee);
	}
	:global(.pg-pick-opt[data-selected]) {
		color: var(--ph-accent-text, #0a7d55);
		font-weight: 700;
	}
</style>
