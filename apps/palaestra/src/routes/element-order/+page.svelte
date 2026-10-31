<script lang="ts">
	// THE ELEMENT-ORDER LAB (e2e/element-order.spec.ts): a hole's answer morphed into a custom element
	// that rearranged its own light DOM at upgrade — one panel after the answer, never two.
	import Panel from '$lib/elementorder/Panel.svelte' with { render: 'deferred' };
	import PanelFallback from '$lib/elementorder/Panel.svelte';

	// (it re-appends once its children are parsed, like a runtime that mounts after the document)
	const define = `<script>customElements.define('eo-shell', class extends HTMLElement { connectedCallback() { const move = () => { for (const el of Array.from(this.children)) this.append(el); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', move, { once: true }); else move(); } });<\/script>`;
</script>

<svelte:head>{@html define}</svelte:head>

<h1>element order</h1>
<Panel full={true}>
	{#snippet ogygiaFallback()}<PanelFallback full={false} />{/snippet}
</Panel>
