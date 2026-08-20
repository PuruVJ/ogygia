<script lang="ts">
	let { start = 0, label = 'TsReg' }: { start?: number; label?: string } = $props();
	// svelte-ignore state_referenced_locally
	let count = $state(start);
</script>

<div class="island" data-tsreg>
	<strong>{label}</strong>:
	<button onclick={() => (count += 1)}>n {count}</button>
</div>
