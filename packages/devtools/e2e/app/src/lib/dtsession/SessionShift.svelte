<script lang="ts">
	// PLANTED unexpected-shift: a click starts a load, and 900 ms later (well past the browser's
	// 500 ms "caused by input" window) a banner appears and pushes the content below it down.
	let open = $state(false);
</script>

<div data-ds="shift">
	<button onclick={() => setTimeout(() => (open = true), 900)}>load notice</button>
	{#if open}<div style="height: 200px; background: #fef3c7">a notice that arrived late</div>{/if}
	<p style="font-size: 20px; padding: 16px 0; margin: 0">content under the notice</p>
</div>
