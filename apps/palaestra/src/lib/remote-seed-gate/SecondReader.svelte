<script lang="ts">
	// An island that imports ONLY `second.remote` — reaches that module, not `greetings.remote`.
	import { second } from './second.remote';
	let { n }: { n: string } = $props();
	// svelte-ignore state_referenced_locally
	const res = await second(n);
</script>

<div class="island" data-second-reader>second: {res.n}</div>
