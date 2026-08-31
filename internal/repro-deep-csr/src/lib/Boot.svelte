<script lang="ts">
	// Headless boot island (BootEffects shape): renders nothing, proves its effect ran.
	$effect(() => {
		document.documentElement.dataset.boot = 'on';
	});
</script>
