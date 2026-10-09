<script lang="ts">
	// /dt-batch: holes on the first screen that wake together (`visible`, one observer callback), so
	// the runtime sends them as ONE batch request. `slow` awaits 1.2 s of "data": its part of the
	// batch lands last — the devtools must say the server held it, never the browser's request gate.
	import type { Snippet } from 'svelte';
	let { n, slow = false }: { n: number; slow?: boolean; ogygiaFallback?: Snippet } = $props();
	await new Promise((ok) => setTimeout(ok, slow ? 1200 : 30));
</script>

<p data-hole-answer="batch-{n}">batched hole {n}: answered</p>
