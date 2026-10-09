<script lang="ts">
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import LazyCaller from '$lib/remote-seed-gate/LazyCaller.svelte' with { wake: 'load' };
</script>

<h1>dynamic import</h1>
<LakeGreeting />
<LazyCaller />
