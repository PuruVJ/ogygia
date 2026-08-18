<script>
	import RSWrapper from '$lib/RSWrapper.svelte';
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<h1>region-snippet: forwarded children</h1>
<RSWrapper>
	<p class="rs-prose">frozen static prose</p>
	<strong class="rs-b">and bold</strong>
	<Counter label="nested-in-slot" start={5} />
</RSWrapper>
