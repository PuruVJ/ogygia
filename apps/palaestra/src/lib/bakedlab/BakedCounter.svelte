<script lang="ts">
	// An island inside the baked region: it must wake (and count) on a Kit-hydrated page.
	let { name }: { name: string } = $props();
	let count = $state(0);
</script>

<button data-bk-counter={name} onclick={() => count++}
	>{name} · <span data-bk-n>{count}</span></button
>
