<script lang="ts">
	/**
	 * Version / locale switcher for a `dimensions()` site — one dropdown per axis, in the header. Built
	 * on Bits UI `DropdownMenu` so it's a REAL menu widget: roving arrow-key nav, typeahead, `Escape` +
	 * outside-click dismiss, focus return, and `menuitemradio` + `aria-checked` semantics (single choice
	 * per axis) all come for free. Options carry pharos-baked hrefs; selecting one routes through the
	 * ogygia SPA router.
	 *
	 * Interactive → use as an ISLAND (the Shell marks it `with { wake: 'load' }`). It re-hydrates per nav,
	 * so the picker stays live after a body-swap.
	 */
	import { DropdownMenu } from 'bits-ui';
	import type { Switcher } from '../dimensions.js';

	// Route through the ogygia SPA router, imported lazily on select so the router module never loads
	// during this island's SSR (and adds no weight to the server bundle).
	async function go(href: string) {
		const { goto } = await import('../../runtime/router.js');
		goto(href);
	}

	let {
		switcher,
		for: forAxis
	}: {
		switcher: Switcher;
		/** Render only these axes (e.g. `for="version"`), so axes can live in different header slots. */
		for?: string | string[];
	} = $props();

	const wanted = $derived(forAxis ? (Array.isArray(forAxis) ? forAxis : [forAxis]) : null);
	const axes = $derived(wanted ? switcher.filter((a) => wanted.includes(a.axis)) : switcher);
</script>

{#if axes?.length}
	<div class="ph-switcher">
		{#each axes as ax (ax.axis)}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger class="ph-sw-trigger" title={ax.label}>
					<span class="ph-sw-value">{ax.current}</span>
					<svg class="ph-sw-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content class="ph-sw-menu" sideOffset={6} align="end" aria-label={ax.label}>
						<DropdownMenu.RadioGroup value={ax.current}>
							{#each ax.options as o (o.value)}
								<DropdownMenu.RadioItem
									class="ph-sw-opt{o.missing ? ' ph-missing' : ''}"
									value={o.value}
									onSelect={() => go(o.href)}
									title={o.missing ? `${o.value} — not translated, falls back` : o.value}
								>
									{#snippet children({ checked })}
										<span class="ph-sw-opt-val">{o.value}</span>
										{#if checked}
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
										{/if}
									{/snippet}
								</DropdownMenu.RadioItem>
							{/each}
						</DropdownMenu.RadioGroup>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		{/each}
	</div>
{/if}
