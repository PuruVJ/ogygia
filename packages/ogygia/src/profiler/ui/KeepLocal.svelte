<script lang="ts">
	/**
	 * KEEP THIS REPORT — a tiny `wake:'load'` island on every server-rendered report page: if this
	 * browser does not hold the report yet, fetch its dump on idle and store it (ui/store.ts), so
	 * the report survives the server (a restart, or an ephemeral instance). The run page already
	 * keeps a fresh recording before opening it; this covers reports opened any other way (a header
	 * profile's link, a trap catch on the dashboard, an upload).
	 */
	import { get_report, put_report } from './store.js';
	import { report_request } from './report-request.js';

	let { base, id, ogpB64 = '' }: { base: string; id: string; ogpB64?: string } = $props();
	let state_ = $state<'checking' | 'kept' | 'keeping' | 'failed' | 'none'>('checking');

	async function keep() {
		try {
			if (await get_report(id)) {
				state_ = 'kept';
				return;
			}
			state_ = 'keeping';
			// the page's .ogp bytes ride along (report-request.ts): this runs on idle, a separate request
			// that a serverless host routes to any instance, rarely the one that rendered this page
			const res = await report_request(base, id, 'dump', ogpB64);
			if (!res.ok) throw new Error(String(res.status));
			const dump = (await res.json()) as { meta: { id: string; created: number; trigger: string } };
			state_ = (await put_report(dump)) ? 'kept' : 'failed';
		} catch {
			state_ = 'failed';
		}
	}
	const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
	if (idle) idle(() => void keep(), { timeout: 3000 });
	else setTimeout(() => void keep(), 500);
</script>

<span class="keep hint" title="Reports are kept in this browser's own storage so they outlive the server (an ephemeral host forgets them within seconds)">
	{#if state_ === 'kept'}kept in this browser{:else if state_ === 'keeping'}keeping in this browser…{:else if state_ === 'failed'}could not keep in this browser{:else}&nbsp;{/if}
</span>

<style>
	.keep {
		margin-left: 8px;
	}
</style>
