<script lang="ts">
	// PLANTED repeated-requests + failed-requests: one click asks for the same thing four times, and
	// for a missing one.
	let got = $state(0);
	async function load() {
		for (let i = 0; i < 4; i++) {
			await fetch('/hell/api/session?ms=5&from=session-lab');
			got++;
		}
		await fetch('/dt-session-missing.json').catch(() => {});
	}
</script>

<button data-ds="fetch" onclick={load}>fetch {got}</button>
