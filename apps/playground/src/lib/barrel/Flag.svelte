<script lang="ts">
	let { on = false }: { on?: boolean } = $props();
	// svelte-ignore state_referenced_locally
	let value = $state(on);
</script>

<div class="island" data-flag>
	<button onclick={() => (value = !value)}>flag is {value ? 'ON' : 'OFF'}</button>
</div>
