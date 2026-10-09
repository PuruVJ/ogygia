<script lang="ts">
	// Kit hydrates this page: the button proves Kit's client is alive next to the adopted lake.
	let n = $state(0);
</script>

<h1 data-page>csr=true page under the lake-chrome layout (the lake must NOT vanish)</h1>
<button data-kit-btn onclick={() => n++}>kit:{n}</button>
