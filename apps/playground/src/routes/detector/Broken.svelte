<script lang="ts">
	let { label }: { label: string } = $props();
	let n = $state(0);
</script>

<div data-testid="broken-root">
	<p>{label}</p>
	<button data-testid="broken-btn" onclick={() => n++}>clicked {n}</button>
</div>
