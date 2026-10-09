<script lang="ts">
	// PLANTED slow handler: its click runs 260 ms of work before the frame can paint. The devtools must
	// name this island, the click, and "in its handlers" as where the time went.
	let saved = $state(0);
	function save() {
		const until = performance.now() + 260;
		while (performance.now() < until) {
			/* planted: the handler's own work */
		}
		saved++;
	}
</script>

<button data-inp="save" onclick={save}>Save</button>
<span data-inp-saved>{saved}</span>
