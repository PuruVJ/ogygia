<script lang="ts">
	// A lake awaiting a PRERENDER remote (`p` bucket) — gated exactly like a query.
	import { getManifesto } from '$lib/greetings.remote';
	// svelte-ignore state_referenced_locally
	const m = await getManifesto();
</script>

<div class="lake" data-manifesto-lake>manifesto: {m.text}</div>
