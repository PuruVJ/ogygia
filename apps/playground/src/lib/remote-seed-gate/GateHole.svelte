<script lang="ts">
	// A deferred hole that awaits a query on the ENDPOINT (its own request — no page seed can carry
	// that). Its `ogygiaFallback` renders in the PAGE pass, where a lake inside it awaits the query
	// too — a page-pass call, gated like any other.
	import type { Snippet } from 'svelte';
	import { getGreeting } from '$lib/greetings.remote';
	let { ogygiaFallback }: { ogygiaFallback?: Snippet } = $props();
	// svelte-ignore state_referenced_locally
	const res = await getGreeting('hole');
</script>

<div data-gate-hole>hole: {res.greeting}</div>
