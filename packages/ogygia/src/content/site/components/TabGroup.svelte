<script lang="ts">
	/**
	 * Tabbed content, site-wide memory — `<TabGroup group="..."><Tab label="npm">…</Tab></TabGroup>` (or
	 * the injected `::: code-group` / `::: tabs`). A PLAIN, overridable wrapper: it forwards the `<Tab>`
	 * panels into an internal island, where they cross the boundary FROZEN (a static region snippet) — so
	 * the panels ship as server HTML that never re-hydrates, and only the tab BAR is interactive. Being a
	 * plain component, it re-exports, wraps, and swaps for your own component cleanly (no compiler magic).
	 *
	 * No `labels` prop: the island reads each tab's label from the frozen panel's own `data-label`, so
	 * hand-authored `<Tab label>` and injected `:::` blocks work identically with nothing to thread.
	 */
	import TabGroupIsland from './TabGroupIsland.svelte' with { wake: 'load' };
	import type { Snippet } from 'svelte';

	let { group = 'tabs', children }: { group?: string; children: Snippet } = $props();
</script>

<TabGroupIsland {group}>{@render children()}</TabGroupIsland>
