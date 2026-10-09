<script lang="ts">
	// The decoy: a click that does almost nothing. Clicked alone, it is never the slow one; clicked
	// right after BusyTimer's button, it waits behind that timer's long task (the delay plant).
	let n = $state(0);
</script>

<button data-inp="count" onclick={() => n++}>Count</button>
<span data-inp-count>{n}</span>
