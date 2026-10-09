<script lang="ts">
	// An island whose markup BRANCHES on `page.data` — the customer's header search bar shape:
	// `{#if page.data.loggedIn} … {:else if markup} {@html markup} {/if}`. Server and client must read
	// the same `page.data`, or the client takes another branch and Svelte discards the server DOM.
	// Imports the shim the `$app/state` alias resolves to inside a compiled island.
	import { page } from '../../../src/shims/app-state.svelte.js';
	const markup = ((page.data as { searchBarMarkup?: string }).searchBarMarkup ?? '') as string;
</script>

{#if page.data.loggedIn}
	<b data-testid="branch">logged-in</b>
{:else if markup}
	<div data-testid="branch">{@html markup}</div>
{/if}
