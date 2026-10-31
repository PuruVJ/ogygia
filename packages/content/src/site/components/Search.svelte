<script lang="ts">
	/**
	 * Full-text search — the ⌘K command palette. THIS component is the LIGHT half: the SSR'd trigger
	 * (a real `<a href="/search">`, so no-JS users get the results page) plus the global keybinding.
	 * The heavy half — Bits UI Dialog+Command, the Orama worker, the index fetch — lives in
	 * `SearchPalette.svelte`, dynamically imported on FIRST INTENT (trigger click, ⌘K, `/`). A docs
	 * page that never searches pays ~nothing for search.
	 *
	 * An ISLAND (`with { wake }`): SSR renders just the trigger; on hydrate the keybinding arms.
	 *
	 * `mode`: `'dialog'` (default) = the command palette; `'inline'` = the bare Command (input + list)
	 * for the mobile sheet, which already provides the modal — inline mounts its palette immediately
	 * (the sheet opening WAS the intent).
	 */
	import { onMount } from 'svelte';
	import { on } from 'svelte/events';
	import { get_shell_context } from '../context.js';
	import type { SearchHit } from '../search.js';
	import type SearchPaletteT from './SearchPalette.svelte';

	// ── regexes
	const TEXT_FIELD_TAG_RE = /^(input|textarea|select)$/i;

	let {
		base,
		endpoint,
		query,
		mode = 'dialog',
		action,
		placeholder = 'Search',
		limit = 10
	}: {
		base?: string;
		endpoint?: string;
		query?: (q: string) => Promise<SearchHit[]>;
		mode?: 'dialog' | 'inline';
		/** No-JS fallback URL — a real `/search` page. Default `${base}/search`. */
		action?: string;
		placeholder?: string;
		limit?: number;
	} = $props();

	const ctx = get_shell_context();
	// svelte-ignore state_referenced_locally
	const the_base = base ?? ctx?.base ?? '';
	// svelte-ignore state_referenced_locally
	const search_action = action ?? `${the_base}/search`;

	// svelte-ignore state_referenced_locally
	let open = $state(mode === 'inline');
	let Palette = $state<typeof SearchPaletteT | null>(null);

	/** First intent: pull the heavy half (Bits + worker + index all start from its mount). */
	async function wake_palette() {
		Palette ??= (await import('./SearchPalette.svelte')).default;
	}

	async function open_palette() {
		await wake_palette();
		open = true;
	}

	onMount(() => {
		// inline mode (a sheet) — the sheet opening was the intent; mount the palette now.
		if (mode === 'inline') void wake_palette();

		// ⌘K / Ctrl-K (or a lone `/`) opens the palette from anywhere — dialog mode only.
		if (mode !== 'dialog') return;
		return on(window, 'keydown', (e: KeyboardEvent) => {
			const k = e.key.toLowerCase();
			const el = e.target as HTMLElement | null;
			// A bare `/` must NOT hijack search while the user is typing — including in a contenteditable
			// EDITOR (CodeMirror and friends are `contenteditable` divs, not <input>/<textarea>), where `/`
			// is a real character (division, comments, closing tags, regex).
			const typing = TEXT_FIELD_TAG_RE.test(el?.tagName ?? '') || el?.isContentEditable === true;
			if ((e.metaKey || e.ctrlKey) && k === 'k') {
				e.preventDefault();
				if (open) open = false;
				else void open_palette();
			} else if (k === '/' && !typing && !open) {
				e.preventDefault();
				void open_palette();
			}
		});
	});
</script>

{#if mode === 'dialog'}
	<!-- A real link to /search — JS intercepts to open the palette; no-JS follows it to the page.
	     Hover/focus WARMS the heavy half (module + worker + index) so the open feels instant: the
	     palette mounts closed and starts fetching while the pointer is still travelling. -->
	<a
		class="og-search-trigger"
		href={search_action}
		onpointerenter={() => void wake_palette()}
		onfocus={() => void wake_palette()}
		onclick={(e) => { e.preventDefault(); void open_palette(); }}
	>
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
		<span class="og-search-trigger-label">{placeholder}</span>
		<kbd class="og-search-kbd">⌘K</kbd>
	</a>
{/if}

{#if Palette}
	<Palette base={the_base} {endpoint} {query} {limit} {placeholder} action={search_action} {mode} bind:open />
{/if}
