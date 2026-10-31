<script lang="ts">
	// PLANTED healed: a page script rewrites this island's text before it wakes (it wakes when
	// visible, far down); the runtime puts the server markup back and hydrates that.
	let n = $state(0);
</script>

<div data-dt="edited"><button onclick={() => n++}>edited {n}</button></div>
