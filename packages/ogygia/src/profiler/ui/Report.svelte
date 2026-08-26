<script lang="ts">
	/**
	 * The report PAGE — a thin router over the one renderer (`ReportBody`). `/report/[id]` is public;
	 * its load returns the server report ONLY when logged in. So:
	 *   - `data.report` present → render it (your own captured report).
	 *   - absent → this is a **share link**: `PermalinkGate` (a client island) reads the URL `#fragment`,
	 *     asks for the password, decrypts it in the browser, and renders the SAME `ReportBody`.
	 * One view, one renderer, two data sources — nothing on the server ever sees a shared report.
	 */
	import ReportBody from './ReportBody.svelte';
	import PermalinkGate from './PermalinkGate.svelte' with { wake: 'load' };
	import type { ProfilerRoutes } from '../profiler-router.js';

	let { data }: ProfilerRoutes['/report/[id]'] = $props();
</script>

{#if data.report}
	<ReportBody
		a={data.report.a}
		meta={data.report.meta}
		base={data.report.base}
		extras={data.report.extras}
		ogpB64={data.report.ogpB64}
	/>
{:else}
	<PermalinkGate base={data.base} />
{/if}
