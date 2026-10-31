<script lang="ts">
	// DECOY for eager-hidden: the phone-only bar, woken by the media query that shows it — a wide
	// screen never loads it, so nothing may name it.
	import PhoneBar from './PhoneBar.svelte';
</script>

<PhoneBar label="phone bar, woken by its query" />
