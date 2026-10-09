<script lang="ts">
	// PLANTED rage-click: the click works, but nothing on screen answers for 1.5 s — so a visitor
	// clicks again, and again.
	let n = $state(0);
	function later() {
		setTimeout(() => n++, 1500);
	}
</script>

<button data-ds="late" onclick={later}>late {n}</button>
