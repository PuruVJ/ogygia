<script lang="ts">
	// A SERVER-ROUTER page's island that reads the page (e2e/router-seed.spec.ts): the router's
	// document must ship the page seed for it, shaped to the one key it reads — and a router page
	// whose islands read nothing ships none.
	import { page } from '$app/state';
	const who = $derived(page.data.who as string);
</script>

<span data-rtr-who>{who}</span>
