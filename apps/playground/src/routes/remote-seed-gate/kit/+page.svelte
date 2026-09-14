<script lang="ts">
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<h1>csr=true twin</h1>
<LakeGreeting />
<Counter label="kit page" />
