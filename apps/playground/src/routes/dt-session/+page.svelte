<script lang="ts">
	// The devtools Record tab's ANSWER KEY page (internal/bench/devtools-session-key.mjs): each
	// island plants one problem a visitor would hit while using the page; the decoy answers cleanly.
	// The "dead" button sits in plain HTML (no island): its click can do nothing.
	import SessionSlow from '$lib/dtsession/SessionSlow.svelte' with { wake: 'load' };
	import SessionLate from '$lib/dtsession/SessionLate.svelte' with { wake: 'load' };
	import SessionShift from '$lib/dtsession/SessionShift.svelte' with { wake: 'load' };
	import SessionFetch from '$lib/dtsession/SessionFetch.svelte' with { wake: 'load' };
	import SessionThrow from '$lib/dtsession/SessionThrow.svelte' with { wake: 'load' };
	import SessionChurn from '$lib/dtsession/SessionChurn.svelte' with { wake: 'load' };
	import SessionServer from '$lib/dtsession/SessionServer.svelte' with { wake: 'load' };
	import Decoy from '$lib/dtsession/Decoy.svelte' with { wake: 'load' };
</script>

<h1>session lab</h1>
<Decoy />
<SessionSlow />
<SessionLate />
<SessionFetch />
<SessionThrow />
<SessionChurn />
<SessionServer />
<button data-ds="dead">dead (no island)</button>
<SessionShift />
