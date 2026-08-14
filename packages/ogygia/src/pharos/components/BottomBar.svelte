<script lang="ts">
	/**
	 * A fixed bottom action bar — the mobile chrome anchor (thumb-reachable by default; that is the
	 * point of bottom-first nav). A layout container only: `lead` (brand) on the left, `actions`
	 * (buttons: search, theme, menu) on the right. What those buttons DO is the composing shell's job.
	 */
	import type { Snippet } from 'svelte';

	let {
		lead,
		actions,
		label = 'Site'
	}: {
		lead?: Snippet;
		actions?: Snippet;
		label?: string;
	} = $props();
</script>

<nav class="ph-bottombar" aria-label={label}>
	<div class="ph-bottombar-lead">{#if lead}{@render lead()}{/if}</div>
	<div class="ph-bottombar-actions">{#if actions}{@render actions()}{/if}</div>
</nav>
