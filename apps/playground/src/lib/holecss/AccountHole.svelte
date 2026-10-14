<script lang="ts">
	// A server-only hole (e2e/hole-css.spec.ts). It renders, on the server, a kit component taken from
	// a workspace package's TypeScript barrel and one from a local barrel (their CSS: the hole's own
	// sheet, built by the tree-CSS walk), and holds an island whose click-only flyout brings more
	// (its CSS: the island's own chunk sheet, carried in the hole's answer).
	import type { Snippet } from 'svelte';
	import { KitHeading } from 'repro-hole-css-kit/components';
	import { LocalTitle } from './index.js';
	import HoleMenu from './HoleMenu.svelte' with { wake: 'load' };
	let { ogygiaFallback }: { ogygiaFallback?: Snippet } = $props();
</script>

<div class="account-hole" data-account-hole>
	<KitHeading />
	<LocalTitle />
	<HoleMenu />
</div>

<style>
	.account-hole {
		margin: 1px;
	}
</style>
