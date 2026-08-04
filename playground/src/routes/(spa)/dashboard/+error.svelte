<script>
	import { page } from '$app/state';
</script>

<h1 data-error-page>Error {page.status}</h1>
<p data-error-message>{page.error?.message}</p>
<a href="/dashboard/orders">← back to orders</a>
