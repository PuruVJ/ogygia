<script lang="ts">
	/**
	 * Download a report file — the self-contained HTML (`as: 'html'`) or the agent JSON (`'json'`) —
	 * as a `wake:'load'` island. The report rides with the request (report-request.ts), so whichever
	 * instance answers can build the file: on a serverless host the one that made the report is
	 * usually gone, and a plain link by id 404s.
	 */
	import { report_request } from './report-request.js';

	let {
		base,
		id,
		ogpB64 = '',
		as = 'html',
		link = false
	}: { base: string; id: string; ogpB64?: string; as?: 'html' | 'json'; link?: boolean } = $props();
	let busy = $state(false);
	let error = $state('');

	const href = $derived(`${base}/report/${id}.${as}`);
	const name = $derived(`ogygia-profile-${id}.${as}`);

	function save(blob: Blob) {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1500);
	}

	async function download(e: MouseEvent) {
		e.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		try {
			const res = await report_request(base, id, as, ogpB64);
			if (!res.ok) throw new Error((await res.text()).slice(0, 200) || String(res.status));
			save(await res.blob());
		} catch (err) {
			error = err instanceof Error ? err.message : 'download failed';
		} finally {
			busy = false;
		}
	}
</script>

{#if link}
	<a {href} download={name} onclick={download} aria-busy={busy}>{busy ? 'building…' : 'JSON'}</a>
{:else}
	<a class="btn" {href} download={name} onclick={download} aria-busy={busy} title="One HTML file with everything inlined — opens from disk, islands live. Built app only."
		>{busy ? 'Building…' : 'Download'}<span class="sub">.html</span></a
	>
{/if}
{#if error}<span class="hint warn" role="alert">Download failed: {error}</span>{/if}
