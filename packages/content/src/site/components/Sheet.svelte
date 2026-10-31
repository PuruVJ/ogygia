<script lang="ts">
	/**
	 * A slide-up bottom sheet — the mobile nav/search surface. Built on Bits UI `Dialog`, so the hard
	 * accessibility is handled: focus trap, focus return, `Escape`, outside-pointer close, body
	 * scroll-lock, `aria-modal`, and `inert`-ing the background all come for free. We own only the
	 * bottom-sheet look (CSS) and the drag handle. `open` is bindable; content is yours via `children`;
	 * an optional pinned `footer` snippet stays at the bottom (e.g. a GitHub link).
	 *
	 * Interactive → use as an ISLAND (a shell marks it `with { wake: 'load' }`). On SSR it renders
	 * nothing (Bits mounts the sheet only when open), so csr=false pages degrade to no sheet rather
	 * than a broken one.
	 */
	import { Dialog } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		label = 'Menu',
		children,
		footer
	}: {
		open?: boolean;
		label?: string;
		children: Snippet;
		footer?: Snippet;
	} = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="og-sheet-backdrop" />
		<Dialog.Content
			class="og-sheet"
			aria-label={label}
			onInteractOutside={(e) => {
				// The bottom-bar menu button toggles `open` itself. Let its pointer-down through — otherwise
				// Bits closes on outside-interact, then the button's click sees `open=false` and REOPENS
				// (the sheet flickers shut then back open). The button carries `data-ph-sheet-toggle`.
				const t = e.target;
				if (t instanceof Element && t.closest('[data-ph-sheet-toggle]')) e.preventDefault();
			}}
		>
			<Dialog.Title class="og-sr-only">{label}</Dialog.Title>
			<div class="og-sheet-handle" aria-hidden="true"><span></span></div>
			<div class="og-sheet-body">{@render children()}</div>
			{#if footer}<div class="og-sheet-footer">{@render footer()}</div>{/if}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
