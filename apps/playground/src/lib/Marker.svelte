<script lang="ts">
	let marker = $state('(pending)');
	$effect(() => {
		marker = String(window.__marker);
	});
</script>

<div class="island" data-marker-island>
	runtime <code>window.__marker</code>: <span data-marker-value>{marker}</span>
</div>
