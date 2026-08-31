<script lang="ts">
	/**
	 * Export the report as its encrypted `.ogp` — a `wake:'load'` island. The bytes ride as a prop
	 * (base64), decoded to a Blob and downloaded client-side, so it works even after the server evicts
	 * the report (was report.ts's export_button + inline script). No key in the browser.
	 */
	let { id, ogpB64 }: { id: string; ogpB64: string } = $props();

	function download() {
		const bin = atob(ogpB64);
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		const blob = new Blob([arr], { type: 'application/octet-stream' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `profile-${id}.ogp`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1500);
	}
</script>

<button type="button" class="btn primary" onclick={download}>
	<svg
		class="ic"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"><path d="M12 3v13m0 0l-4.5-4.5M12 16l4.5-4.5M4 21h16" /></svg
	>
	Export<span class="sub">.ogp · encrypted</span>
</button>
