<script lang="ts">
	// Level 3: the mark must propagate transitively all the way down. A leaf that reads the page
	// only here (its ancestors could have been the sole `$app/*` importers) still gets the shim,
	// because every hop re-mints `?og-region` onto the resolved child.
	import { page } from '$app/state';
</script>

<span data-split-grandchild-path>{page.url.pathname}</span>
