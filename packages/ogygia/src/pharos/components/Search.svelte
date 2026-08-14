<script lang="ts">
	/**
	 * Full-text search — the ⌘K command palette, built on Bits UI so the hard accessibility is handled
	 * for us: `Dialog` gives the modal (portal to <body>, focus trap, Esc, outside-click close, focus
	 * return, aria-modal); `Command` gives the palette (roving keyboard nav, aria-activedescendant,
	 * `LinkItem` hits that navigate on Enter). We own only the query: an Orama worker indexes the
	 * prerendered `search.json` off-thread.
	 *
	 * An ISLAND (`with { wake }`): SSR renders just the trigger link, so with no JS it's a real
	 * `<a href="/search">` to the no-JS results page; on hydrate the ⌘K palette takes over.
	 *
	 * `mode`: `'dialog'` (default) = the command palette; `'inline'` = the bare Command (input + list)
	 * for the mobile sheet, which already provides the modal.
	 */
	import { onMount } from 'svelte';
	import { on } from 'svelte/events';
	import { Command, Dialog } from 'bits-ui';
	import { get_shell_context } from '../context.js';
	import { search as search_handle, type SearchClient } from '../search-client.js';
	import type { SearchHit } from '../search.js';

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

	let q = $state('');
	let results = $state<SearchHit[]>([]);
	// svelte-ignore state_referenced_locally
	let open = $state(mode === 'inline');
	// svelte-ignore state_referenced_locally
	let ready = $state(!!query);
	let error = $state('');

	let client: SearchClient | undefined;

	onMount(() => {
		// eslint-disable-next-line no-undef
		if (query) return; // custom backend — no worker
		// svelte-ignore state_referenced_locally
		client = search_handle({ base: the_base, ...(endpoint ? { endpoint } : {}), limit });
		client.ready.then(() => (ready = true)).catch((e) => {
			error = e instanceof Error ? e.message : String(e);
			// eslint-disable-next-line no-console
			console.error('[pharos] search index unavailable —', error);
		});

		// ⌘K / Ctrl-K (or a lone `/`) opens the palette from anywhere — dialog mode only.
		let off = () => {};
		if (mode === 'dialog') {
			off = on(window, 'keydown', (e: KeyboardEvent) => {
				const k = e.key.toLowerCase();
				const typing = /^(input|textarea|select)$/i.test((e.target as Element)?.tagName ?? '');
				if ((e.metaKey || e.ctrlKey) && k === 'k') {
					e.preventDefault();
					open = !open;
				} else if (k === '/' && !typing && !open) {
					e.preventDefault();
					open = true;
				}
			});
		}
		return () => {
			off();
			client?.destroy();
		};
	});

	function run_query(term: string): Promise<SearchHit[]> {
		if (query) return query(term);
		return client?.query(term) ?? Promise.resolve([]);
	}

	// Attachment on the field wrapper: find the (Bits UI) input and debounce-query on each keystroke.
	// `Command.Input`'s own `bind:value` keeps `q` in sync; this drives the async search off the input
	// events — no reactive effect.
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
						{#if hit.excerpt}<span class="ph-search-hit-excerpt">{hit.excerpt}</span>{/if}
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
	<!-- A real link to /search — JS intercepts to open the palette; no-JS follows it to the page. -->
	<a class="ph-search-trigger" href={search_action} onclick={(e) => { e.preventDefault(); open = true; }}>
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
		<span class="ph-search-trigger-label">{placeholder}</span>
		<kbd class="ph-search-kbd">⌘K</kbd>
	</a>

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
