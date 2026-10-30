<script>
	import Chrome from '#lib/Chrome.svelte' with { wake: 'none' };
	let { children } = $props();
</script>

<Chrome />
{@render children()}
