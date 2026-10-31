<script lang="ts">
	// A NORMAL component (not an island) on the csr=true page. It must use the REAL
	// $app/state (the shims are scoped to island modules only, never leaking here).
	import { page } from '$app/state';
	let n = $state(0);
</script>

<div data-kit-status>
	normal component, real <code>$app/state</code> — path: <strong>{page.url.pathname}</strong>
	<button onclick={() => (n += 1)}>kit-status count {n}</button>
</div>
