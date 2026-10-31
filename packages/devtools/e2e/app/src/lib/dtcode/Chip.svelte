<script lang="ts">
	// A small component behind the lab's barrel.
	let { label }: { label: string } = $props();
</script>

<span class="chip">{label}</span>
