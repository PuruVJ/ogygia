<script lang="ts">
	/**
	 * The .ogp upload — a `wake:'load'` island (was report.ts's inline upload script). Posts the file
	 * bytes + key; the server decrypts and returns the rendered report, which replaces the document.
	 */
	let { base }: { base: string } = $props();
	let key = $state('');
	let error = $state('');
	let busy = $state(false);
	let fileInput: HTMLInputElement;

	async function onFile() {
		const f = fileInput.files?.[0];
		if (!f) return;
		error = '';
		busy = true;
		try {
			const buf = await f.arrayBuffer();
			const res = await fetch(location.pathname, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream', 'x-ogp-key': key },
				body: buf
			});
			const d = await res.json();
			// the report is an islands page, so navigate to it (it renders + hydrates on load)
			if (d.url) location.href = d.url;
			else error = d.error || 'Could not open that file.';
		} catch {
			error = 'Could not read that file.';
		} finally {
			busy = false;
			if (fileInput) fileInput.value = '';
		}
	}
</script>

<p>
	<label>
		key
		<input
			type="password"
			bind:value={key}
			placeholder="the .ogp's export key — blank tries this profiler's own secret"
			size="44"
		/>
	</label>
</p>
<p>
	<input
		type="file"
		bind:this={fileInput}
		onchange={onFile}
		accept=".ogp,application/octet-stream"
		disabled={busy}
	/>
</p>
{#if error}<p class="verdict">{error}</p>{/if}
<p class="hint"><a href={base}>← dashboard</a></p>
