<script lang="ts">
	// Mixed mode: an island on a csr=true page. Kit hydrates the whole tree, so the
	// island degrades gracefully to a normal component (single hydration; our runtime
	// detects Kit and skips its own hydration).
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	import KitStatus from '$lib/KitStatus.svelte';
	// PLAIN import of the split-brain fixture (also an island on /split-brain): this page's
	// copy must keep Kit's REAL `$app/stores` — see e2e/split-brain.ts.
	import SplitHeader from '$lib/split-brain/SplitHeader.svelte';
	// A helper shared with an island on a csr=false page (alias import): this page's copy reads
	// Kit's real page through the shim's kit-page thread — e2e/shared-page-module.spec.ts.
	import { page_name } from '$boot/read-page';
</script>

<nav><a href="/">Home</a> <a href="/kit">Kit page</a></nav>
<hr />
<h1 data-static-shell>Kit page (csr = true) — coexistence demo</h1>
<p data-static-shell>
	This page opts into full Kit hydration. The island below still works, but Kit hydrates it
	(exactly once) as a normal component.
</p>

<Counter start={42} label="Island on a csr=true page" />

<p data-kit-shared-name={page_name()}>shared reader on the Kit page: {page_name()}</p>

<SplitHeader />

<KitStatus />
