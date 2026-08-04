<script>
	let { query = '' } = $props();
	let taps = $state(0);
</script>

<div class="island" data-media-island>
	<strong>media</strong> island (<code>{query}</code>)
	<button onclick={() => (taps += 1)}>taps {taps}</button>
</div>
