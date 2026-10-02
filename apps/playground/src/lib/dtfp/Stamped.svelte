<script lang="ts">
	// /dt-fp: an island whose props carry a value made fresh on every render (`stamp`: the server's
	// clock). Its fingerprint moves on every load — the devtools must name it and the prop.
	let { label, stamp }: { label: string; stamp: number } = $props();
	let on = $state(false);
</script>

<button data-stamped onclick={() => (on = !on)}>{label} ({on ? 'on' : 'off'}, rendered {stamp})</button>
