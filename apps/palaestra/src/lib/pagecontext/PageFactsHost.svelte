<script lang="ts">
	// The page-context lab's island: a region from a remote query, refreshed in a remote request, and
	// one a command returns after changing what the page's load reads.
	import { Region } from 'ogygia';
	import { pageFacts, switchLocale } from './page-context.remote';

	const facts = pageFacts();
	let swapped: Awaited<ReturnType<typeof switchLocale>> | null = $state(null);
</script>

<div data-pc-host>
	{#if swapped}
		<Region of={swapped} />
	{:else if facts.current}
		<Region of={facts.current} />
	{/if}
	<button data-pc-refresh onclick={() => facts.refresh()}>refresh</button>
	<button data-pc-switch onclick={async () => (swapped = await switchLocale('fr'))}>français</button>
</div>
