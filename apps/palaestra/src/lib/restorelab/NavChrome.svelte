<script lang="ts">
	// The restore lab's site nav (e2e/restore.spec.ts): a server-owned custom element the app's transform
	// renders in scoped form, whose OWN client runtime unpacks it on first load — its tree into a shadow
	// root, its original children back in the light DOM (as a scoped component runtime's hydrate does).
	// Both nav pages carry it, so a router navigation morphs it in place.
	const runtime =
		'<script type="module">' +
		'if(!customElements.get("demo-nav"))customElements.define("demo-nav",class extends HTMLElement{connectedCallback(){' +
		'if(this.shadowRoot)return;const tree=this.querySelector(":scope>nav[c-id]");if(!tree)return;' +
		'const root=this.attachShadow({mode:"open"});const wrap=tree.querySelector("slot");const kids=[...wrap.childNodes];' +
		'wrap.replaceWith(document.createElement("slot"));root.append(tree);for(const k of kids)this.append(k);' +
		'for(const el of root.querySelectorAll("[c-id]"))el.removeAttribute("c-id");tree.removeAttribute("c-id")}})' +
		'</' +
		'script>';
</script>

<svelte:head>{@html runtime}</svelte:head>
<demo-nav data-nav>
	<ul data-nav-tabs>
		<li>Products</li>
		<li>Software</li>
		<li>Services</li>
		<li>Solutions</li>
		<li>Homeowner</li>
		<li>Support</li>
		<li>Company</li>
	</ul>
</demo-nav>
