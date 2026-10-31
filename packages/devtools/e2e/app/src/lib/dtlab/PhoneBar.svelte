<script lang="ts">
	// PLANTED eager-hidden: a phone-only bar (its CSS hides it past 600 px) that wakes at load, so a
	// wide screen loads its code to draw nothing. Also the DECOY PhoneBarLazy: the same bar woken by
	// the media query that shows it.
	let { label = 'phone bar' }: { label?: string } = $props();
	let open = $state(false);
</script>

<nav class="dt-phone-bar" data-dt="phone-bar">
	<button onclick={() => (open = !open)}>{label} {open ? 'open' : 'closed'}</button>
</nav>

<style>
	.dt-phone-bar {
		display: none;
	}
	@media (max-width: 600px) {
		.dt-phone-bar {
			display: flex;
		}
	}
</style>
