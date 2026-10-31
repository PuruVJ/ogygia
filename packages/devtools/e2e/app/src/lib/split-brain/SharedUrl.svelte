<script lang="ts">
	// A PLAIN shared component (not a marked island) that reads the page URL. It is a TRANSITIVE dep
	// of the SplitHeader island (csr=false) AND imported directly by /kit (csr=true). prescan never
	// registers it (only marked islands get a componentPath), so its $app membership is decided by
	// resolution order — the exact shared-transitive-dep race. On /split-brain it must read the shim
	// (→ /split-brain); a race would leave it on Kit's empty client store (→ undefined/crash).
	import { page } from '$app/state';
</script>

<span data-shared-url>{page.url.pathname}</span>
