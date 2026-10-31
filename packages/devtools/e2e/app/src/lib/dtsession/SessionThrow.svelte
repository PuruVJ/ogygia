<script lang="ts">
	// PLANTED errors: the click handler throws (after doing its visible part, so it is not dead).
	let n = $state(0);
	function boom() {
		n++;
		setTimeout(() => {
			throw new Error('planted: SessionThrow click failed');
		}, 0);
	}
</script>

<button data-ds="throw" onclick={boom}>throw {n}</button>
