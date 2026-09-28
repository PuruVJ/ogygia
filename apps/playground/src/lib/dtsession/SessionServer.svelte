<script lang="ts">
	// PLANTED server-time: the click asks an endpoint that spends ~450 ms waiting on an upstream call.
	let done = $state(false);
	async function ask() {
		await fetch('/dt-session/api?ms=450');
		done = true;
	}
</script>

<button data-ds="server" onclick={ask}>{done ? 'server answered' : 'ask the server'}</button>
