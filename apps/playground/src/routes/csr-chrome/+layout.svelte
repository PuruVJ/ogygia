<script lang="ts">
	import ChromeHeader from '$lib/ChromeHeader.svelte' with { wake: 'load' };
	import ChromeFooter from '$lib/ChromeFooter.svelte' with { wake: 'load' };
	let { children } = $props();
</script>

<ChromeHeader />
{@render children()}
<ChromeFooter />
