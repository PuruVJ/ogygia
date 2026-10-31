<script lang="ts">
	// prerender() demo: a remote function whose result can be baked at build time. On this
	// NON-prerendered page it runs on the server during SSR (the island endpoint / csr=false render)
	// because it is declared `dynamic: true`. Its text is deterministic, so it survives hydration.
	import { getManifesto } from '$lib/greetings.remote';
	const m = await getManifesto();
</script>

<div class="island" data-prerender-probe>
	<strong data-prerender-text>{m.text}</strong>
	<span data-prerender-at>({m.at})</span>
</div>
