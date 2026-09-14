<script lang="ts">
	import ResolvedGreeting from '$lib/ResolvedGreeting.svelte' with { wake: 'load' };
</script>

<h1>layout script + reader</h1>
<ResolvedGreeting name="reader" />
