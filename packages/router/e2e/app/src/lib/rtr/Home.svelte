<script>
	import Badge from './Badge.svelte';
	let { data } = $props();
</script>
<h1 data-testid="page">router home page who={data?.who} <Badge /></h1>
