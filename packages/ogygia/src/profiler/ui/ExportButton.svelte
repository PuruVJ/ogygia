<script lang="ts">
	/**
	 * Export the report as its encrypted `.ogp` — a `wake:'load'` island. With the bytes on the page
	 * (`ogpB64`, base64) they are decoded to a Blob and downloaded client-side, so it works even after
	 * the server evicts the report. A report shown from this browser's kept copy has no bytes (only a
	 * server holds the key): the kept copy rides to whichever instance answers, and it encrypts it
	 * (report-request.ts). No key in the browser either way.
	 */
	import { page_ogp, report_request } from './report-request.js';

	let { id, ogpB64 = '', base = '' }: { id: string; ogpB64?: string; base?: string } = $props();
	let busy = $state(false);
	let error = $state('');

	function save(blob: Blob) {
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `profile-${id}.ogp`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1500);
	}

	async function download() {
		// the bytes: a prop when given one, else the page's one copy (report-request.ts page_ogp)
		const b64 = ogpB64 || page_ogp();
		if (b64) {
			const bin = atob(b64);
			const arr = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
			save(new Blob([arr], { type: 'application/octet-stream' }));
			return;
		}
		if (busy) return;
		busy = true;
		error = '';
		try {
			// no bytes on the page: the kept copy goes along (ogpB64 empty, so report_request sends it)
			const res = await report_request(base, id, 'ogp');
			if (!res.ok) throw new Error((await res.text()).slice(0, 200) || String(res.status));
			save(await res.blob());
		} catch (err) {
			error = err instanceof Error ? err.message : 'export failed';
		} finally {
			busy = false;
		}
	}
</script>

<button type="button" class="btn primary" onclick={download} aria-busy={busy}>
	<svg
		class="ic"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"><path d="M12 3v13m0 0l-4.5-4.5M12 16l4.5-4.5M4 21h16" /></svg
	>
	{busy ? 'Encrypting…' : 'Export'}<span class="sub">.ogp · encrypted</span>
</button>
{#if error}<span class="hint warn" role="alert">Export failed: {error}</span>{/if}
