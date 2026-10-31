<script lang="ts">
	// The THIN shell. This is the only file that changes in a real refactor: it renders the whole
	// layout body as ONE load island and passes the page slot into it. Promise fields from `load` stay
	// HERE, awaited server-side (csr=false) — they never cross into the island. Only a plain slice does.
	import LayoutInner from '$lib/LayoutInner.svelte' with { wake: 'load' };

	let { data, children } = $props();

	const plain = { rtl: data.rtl, appName: data.appName };
</script>

{#await data.slowGreeting then greeting}
	<p data-server-promise>{greeting}</p>
{/await}

<LayoutInner data={plain}>{@render children()}</LayoutInner>
