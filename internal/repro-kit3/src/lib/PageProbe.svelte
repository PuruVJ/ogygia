<script>
	// Reads the page inside an island: on a Kit-booted page this is Kit's own page, through the
	// kit-page thread.
	import { page } from '$app/state';
</script>

<p data-probe-path>{page.url.pathname}</p>
