<script lang="ts">
	// A custom element whose `class` Svelte binds (test/browser/host-classes.test.ts): its hydrate
	// writes `class` whole when the DOM's differs.
	let { cls }: { cls: string } = $props();
</script>

<x-hero class={cls}>a</x-hero>
