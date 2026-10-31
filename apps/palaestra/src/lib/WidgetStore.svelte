<script module lang="ts">
	// A transportable class defined in a COMPONENT's `<script module>` (not a .svelte.ts).
	// The plugin registers it (keyed by this .svelte path) and manifests it, so an island
	// receiving it as a prop needs no value import. `import.meta.og.wire` is a compile construct
	// (rewrites to the registry symbol) — no import.
	export class WidgetStore {
		label: string;
		hits = $state(0);

		constructor(label = 'widget', hits = 0) {
			this.label = label;
			this.hits = hits;
		}

		bump() {
			this.hits += 1;
		}

		static wire = import.meta.og.wire({
			encode: (s: WidgetStore) => ({ label: s.label, hits: s.hits }),
			decode: (d: { label: string; hits: number }) => new WidgetStore(d.label, d.hits)
		});
	}
</script>

<script lang="ts">
	// Instance script: this component also renders the store (the writer island).
	let { store }: { store: WidgetStore } = $props();
</script>

<div class="island" data-widget-writer>
	<strong>{store.label}</strong>
	<button onclick={() => store.bump()}>bump ({store.hits})</button>
</div>
