<script lang="ts">
	/**
	 * The HEAVY half of search — Bits UI Dialog+Command, the Orama worker, and the index fetch. Loaded
	 * by `Search.svelte` via dynamic import on FIRST INTENT (trigger click, ⌘K, `/`), so none of it
	 * rides the initial page: the palette is interaction-priced, exactly like the islands doctrine
	 * says chrome should be. Mounting this component IS the intent signal — the worker spins up and
	 * the prerendered index fetches from here, not at page hydrate.
	 */
	import { onMount } from 'svelte';
	import { on } from 'svelte/events';
	import { Command, Dialog } from 'bits-ui';
	import { search as search_handle, type SearchClient } from '../search-client.js';
	import type { SearchHit } from '../search.js';

	let {
		base = '',
		endpoint,
		query,
		limit = 10,
		placeholder = 'Search',
		action = '/search',
		mode = 'dialog',
		open = $bindable(false)
	}: {
		base?: string;
		endpoint?: string;
		query?: (q: string) => Promise<SearchHit[]>;
		limit?: number;
		placeholder?: string;
		action?: string;
		mode?: 'dialog' | 'inline';
		open?: boolean;
	} = $props();

	let q = $state('');
	let results = $state<SearchHit[]>([]);
	// svelte-ignore state_referenced_locally
	let ready = $state(!!query);
	let error = $state('');

	let client: SearchClient | undefined;

	onMount(() => {
		if (query) return; // custom backend — no worker
		client = search_handle({ base, ...(endpoint ? { endpoint } : {}), limit });
		client.ready.then(() => (ready = true)).catch((e) => {
			error = e instanceof Error ? e.message : String(e);
			// eslint-disable-next-line no-console
			console.error('[pharos] search index unavailable —', error);
		});
		return () => client?.destroy();
	});

	function run_query(term: string): Promise<SearchHit[]> {
		if (query) return query(term);
		return client?.query(term) ?? Promise.resolve([]);
	}

	// Attachment on the field wrapper: find the (Bits UI) input and debounce-query on each keystroke.
	let debounce: ReturnType<typeof setTimeout> | undefined;
	function searchField(node: HTMLElement) {
		const input = node.querySelector('input');
		if (!input) return;
		const run = () => {
			const term = input.value.trim();
			clearTimeout(debounce);
			if (!term) {
				results = [];
				return;
			}
			debounce = setTimeout(async () => {
				const hits = await run_query(term);
				if (input.value.trim() === term) results = hits;
			}, 150);
		};
		const off = on(input, 'input', run);
		return () => {
			off();
			clearTimeout(debounce);
		};
	}
	void action;
</script>

{#snippet field()}
	<div class="ph-search-field" {@attach searchField}>
		<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
		<Command.Input bind:value={q} class="ph-search-scene-input" {placeholder} aria-label={placeholder} />
		<kbd class="ph-search-kbd">Esc</kbd>
	</div>
{/snippet}

{#snippet resultsBody()}
	<!-- `Command.List` (role=listbox) stays mounted so the input's `aria-controls`/combobox wiring is
	     always valid. It must never be an EMPTY listbox, so every non-result state renders as a single
	     DISABLED option (aria-disabled, skipped by keyboard nav) — a valid required child. -->
	<Command.List class="ph-search-scene-body">
		<Command.Viewport>
			{#if error}
				<Command.Item disabled value="__error" class="ph-search-error">
					<strong>Search is unavailable.</strong>
					<span>{error}</span>
				</Command.Item>
			{:else if results.length}
				{#each results as hit (hit.href)}
					<Command.LinkItem href={hit.href} value={hit.href} class="ph-search-hit">
						<span class="ph-search-hit-title"
							>{hit.title}{#if hit.heading}<span class="ph-search-hit-heading"> › {hit.heading}</span>{/if}</span
						>
						{#if hit.excerpt}<span class="ph-search-hit-excerpt">{@html hit.excerpt}</span>{/if}
						<span class="ph-search-hit-section">{hit.section}</span>
					</Command.LinkItem>
				{/each}
			{:else if q.trim() && ready}
				<Command.Item disabled value="__empty" class="ph-search-empty">No results for “{q}”</Command.Item>
			{:else}
				<Command.Item disabled value="__hint" class="ph-search-hint">Type to search the docs…</Command.Item>
			{/if}
		</Command.Viewport>
	</Command.List>
{/snippet}

{#if mode === 'inline'}
	<Command.Root shouldFilter={false} loop class="ph-search ph-search-inline">
		{@render field()}
		{@render resultsBody()}
	</Command.Root>
{:else}
	<Dialog.Root bind:open>
		<Dialog.Portal>
			<Dialog.Overlay class="ph-search-backdrop" />
			<Dialog.Content class="ph-search-panel" aria-label={placeholder}>
				<Dialog.Title class="ph-sr-only">{placeholder}</Dialog.Title>
				<Command.Root shouldFilter={false} loop class="ph-search">
					{@render field()}
					{@render resultsBody()}
				</Command.Root>
			</Dialog.Content>
		</Dialog.Portal>
	</Dialog.Root>
{/if}
