<script lang="ts">
	let { title, header, children } = $props();
	let bumped = $state(0);
</script>

<div class="island" data-snippet-island>
	<h3>{title}</h3>
	<div data-header>{@render header?.()}</div>
	<div data-children>{@render children?.()}</div>
	<button onclick={() => (bumped += 1)}>bump {bumped}</button>
</div>
