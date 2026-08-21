<script lang="ts">
	// Passthrough the runtime hydrates a top-level island into, so descendants see the
	// "inside an island" context. Mirrors Region.svelte's island SSR shape EXACTLY
	// (`{#if Component}<Component {...props} />{/if}`) so Svelte adopts the SSR nodes in place instead
	// of discarding and re-creating the island root (a re-created root is class-less for a tick → a
	// `class:`-driven `position: fixed` drops to `static` for a frame). SELF-CLOSING on purpose: any
	// slot content here would pass an implicit `children` snippet that OVERRIDES the decoded
	// `props.children` (the revived slot/region snippet) and desyncs hydration with an extra anchor.
	import { setNested } from './context.js';
	import type { Component as SvelteComponent } from 'svelte';

	let { component: Component, props }: { component: SvelteComponent<Record<string, unknown>>; props: Record<string, unknown> } = $props();

	setNested();
</script>

{#if Component}<Component {...props} />{/if}
