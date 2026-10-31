<script lang="ts">
	// DOM OWNERSHIP (e2e/dom-ownership.spec.ts): a widget's definition arrives after the runtime booted
	// (so the island's server copy is pristine) and before the island wakes (interaction). On upgrade it
	// prepends a backdrop and appends a pane to its own light DOM. The wake must keep all of it.
	import Search from '$lib/ownership/Search.svelte' with { wake: 'interaction' };

	const define_widget =
		'<script>addEventListener("load",()=>setTimeout(()=>customElements.define("x-guided-e2e",class extends HTMLElement{' +
		'connectedCallback(){if(this.querySelector(":scope>.p"))return;' +
		'this.prepend(Object.assign(document.createElement("div"),{className:"p"}));' +
		'this.append(Object.assign(document.createElement("div"),{className:"q"}));}}),50));<\/script>';
</script>

<svelte:head>{@html define_widget}</svelte:head>

<h1 data-static-shell>dom ownership — a widget reworks its own light DOM before the island wakes</h1>

<Search />
