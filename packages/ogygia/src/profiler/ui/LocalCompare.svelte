<script lang="ts">
	/**
	 * COMPARE FROM THE BROWSER STORE — when the server no longer holds one of the two reports (it
	 * restarted, or it is an ephemeral instance), the compare page hands the ids to this island,
	 * which reads both dumps from this browser's store, runs the same pure comparison, and renders
	 * the same body.
	 */
	import { get_report } from './store.js';
	import { compare_reports, type Comparison } from '../compare.js';
	import { derive_findings, type ReportMeta, type ReportExtras } from '../report.js';
	import type { Analysis } from '../analyze.js';
	import CompareBody from './CompareBody.svelte';

	let { base, a, b }: { base: string; a: string; b: string } = $props();
	let cmp = $state<Comparison | null>(null);
	let missing = $state<string[]>([]);
	let loaded = $state(false);

	type Dump = { meta: ReportMeta; analysis: Analysis; extras: ReportExtras };
	const pack = (d: Dump) => ({ meta: d.meta, analysis: d.analysis, findings: derive_findings(d.analysis, d.meta, d.extras).map((f) => `${f.code}: ${f.message}`), ...(d.extras.gc_attr ? { gc: d.extras.gc_attr } : {}) });
	void Promise.all([get_report(a), get_report(b)])
		.then(([A, B]) => {
			const da = A?.dump as Dump | undefined;
			const db = B?.dump as Dump | undefined;
			missing = [...(da ? [] : [a]), ...(db ? [] : [b])];
			if (da && db) cmp = compare_reports(pack(da), pack(db));
		})
		.finally(() => (loaded = true));
</script>

{#if cmp}
	<CompareBody {base} {cmp} />
{:else if loaded}
	<h1>Compare</h1>
	<p class="verdict">
		This server no longer holds {missing.length === 2 ? 'either report' : 'one of these reports'}, and this browser did not keep {missing.length === 2 ? 'them' : 'it'} ({missing.join(', ')}).
		A report is kept only by the browser that recorded or opened it.
	</p>
	<p class="hint"><a href={base}>← dashboard</a></p>
{:else}
	<h1>Compare</h1>
	<p class="hint">Reading both reports from this browser…</p>
{/if}
