<script lang="ts">
	// THE ISLAND INSIDE THE HOLE (e2e/hole-css.spec.ts): its flyout renders only after a click, so the
	// hole's server render never holds it — what it shows must still arrive styled. It takes its
	// components by name from a workspace package's TypeScript barrel and from a local barrel.
	import { KitPanel, KitFooter } from 'repro-hole-css-kit/components';
	import { LocalBadge } from './index.js';

	let open = $state(false);
</script>

<div class="hole-menu" data-hole-menu>
	<button data-hole-menu-toggle onclick={() => (open = !open)}>menu</button>
	{#if open}
		<div data-hole-flyout>
			<KitPanel />
			<LocalBadge />
			<KitFooter />
		</div>
	{/if}
</div>

<style>
	.hole-menu {
		padding: 2px;
	}
</style>
