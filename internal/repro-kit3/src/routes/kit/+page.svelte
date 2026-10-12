<script>
	// Kit hydrates this page: the button proves Kit's client is alive next to the lake.
	let n = $state(0);
</script>

<h1 data-page="kit">csr=true page</h1>
<button data-kit-btn onclick={() => n++}>kit:{n}</button>
