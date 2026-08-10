<script lang="ts">
	// Reader island: `import type` only — proves the manifest registered the class that lives
	// in WidgetStore.svelte's `<script module>`, with no value import here.
	import type { WidgetStore } from './WidgetStore.svelte';

	let { store }: { store: WidgetStore } = $props();
</script>

<div class="island" data-widget-reader data-has-method={typeof store?.bump === 'function'}>
	hits = <strong data-widget-hits>{store.hits}</strong>
</div>
