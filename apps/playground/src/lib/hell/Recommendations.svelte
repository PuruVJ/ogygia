<script lang="ts">
	// A DEFERRED HOLE: personalised recommendations rendered on the islands endpoint after the page
	// ships, behind an upstream call of its own. The page sends its fallback in the shell.
	import type { Snippet } from 'svelte';
	import { requestEvent } from 'ogygia';
	import type { RequestEvent } from '@sveltejs/kit';
	let { forProduct }: { forProduct: string; ogygiaFallback?: Snippet } = $props();
	const event = requestEvent<RequestEvent>();
	const origin = event?.url.origin ?? '';
	const res = await fetch(`${origin}/hell/api/recs?ms=40&for=${forProduct}`);
	const recs = (await res.json()) as { name: string; items: string[] };
</script>

<aside data-recs>
	<h4>Recommended with {forProduct}</h4>
	<ul>{#each recs.items as r (r)}<li>{r}</li>{/each}</ul>
</aside>
