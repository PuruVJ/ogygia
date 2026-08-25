<script lang="ts">
	/** Open a saved profile (the /view GET page). Shell + the reactive UploadForm island. Ports
	 *  render_upload_page. */
	import Shell from './Shell.svelte';
	import UploadForm from './UploadForm.svelte' with { wake: 'load' };
	import type { ProfilerRoutes } from '../profiler-router.js';
	let { data }: ProfilerRoutes['/view'] = $props();
	const { base } = $derived(data);
</script>

<Shell>
	<h1>Open a saved profile</h1>
	<p class="hint">
		Recorded on a serverless host (Amplify, Vercel, Netlify) where the report can't be kept in memory?
		Export the <code>.ogp</code> there, then open it here — it's decrypted and rendered by this profiler.
		ANY <code>.ogp</code> opens in ANY profiler: enter the key it was exported with. Leave it blank and
		this profiler tries its OWN secret — so a report this profiler made re-opens without retyping the key.
	</p>
	<UploadForm {base} />
</Shell>
