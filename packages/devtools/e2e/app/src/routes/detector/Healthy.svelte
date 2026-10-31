<script lang="ts">
	let { label }: { label: string } = $props();
	let n = $state(0);
</script>

<div data-testid="healthy-root">
	<p>{label}</p>
	<button data-testid="healthy-btn" onclick={() => n++}>clicked {n}</button>
</div>
