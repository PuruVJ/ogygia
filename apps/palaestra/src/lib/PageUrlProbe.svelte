<script lang="ts">
	// Island that reads `$app/state` *inside* the island module (shimmed on the client).
	// Proves `page.url.*` / params / route / status / data / state survive seeding via
	// `$state.raw` (not a deep proxy that strips URL internal-slot getters). Only `url`
	// needs platform coercion; other fields are plain replace-on-nav snapshots.
	import { page } from '$app/state';

	const pathname = $derived(page.url.pathname);
	const href = $derived(page.url.href);
	const search = $derived(page.url.search);
	const host = $derived(page.url.host);
	const paramId = $derived(page.params.id ?? '');
	const routeId = $derived(page.route.id ?? '');
	const status = $derived(page.status);
	const dataKeys = $derived(Object.keys(page.data ?? {}).sort().join(','));
	const formIsNull = $derived(page.form == null ? 'null' : 'set');
	const errorIsNull = $derived(page.error == null ? 'null' : 'set');
	const stateType = $derived(page.state && typeof page.state === 'object' ? 'object' : typeof page.state);
</script>

<div class="island" data-pageurl-probe>
	<p data-pathname>{pathname}</p>
	<p data-href>{href}</p>
	<p data-search>{search}</p>
	<p data-host>{host}</p>
	<p data-param-id>{paramId}</p>
	<p data-route-id>{routeId}</p>
	<p data-status>{status}</p>
	<p data-data-keys>{dataKeys}</p>
	<p data-form>{formIsNull}</p>
	<p data-error>{errorIsNull}</p>
	<p data-state-type>{stateType}</p>
</div>
