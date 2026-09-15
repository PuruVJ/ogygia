<script lang="ts">
	import { page } from '$app/state';
	// Kit hydrates this error page (the layout's csr): the button proves Kit's client is alive.
	let n = $state(0);
</script>

<h1 data-error-page>Error {page.status}</h1>
<p data-error-message>{page.error?.message}</p>
<button data-kit-btn onclick={() => n++}>kit:{n}</button>
