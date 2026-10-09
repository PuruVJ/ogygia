<script lang="ts">
	// The layout chrome island the regression killed: interactive counter, wake:'load'.
	let n = $state(0);
</script>

<header data-chrome-header>
	<button data-header-count onclick={() => n++}>{n}</button>
</header>
