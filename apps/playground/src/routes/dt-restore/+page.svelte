<script lang="ts">
	// THE LATE-RESTORE LAB for the devtools answer key (needs the restore lab's transform:
	// OGYGIA_RESTORE_LAB=1). A blocking head script defines `demo-card` — the way a component library
	// loaded as a classic script does — so the host upgrades (and makes its own shadow root) before
	// ogygia's restorer runs at the end of the body.
	import { script } from 'ogygia';
	import LateCard from '$lib/dtrestore/LateCard.svelte' with { wake: 'load' };
	const early = script(() => {
		customElements.define(
			'demo-card',
			class extends HTMLElement {
				constructor() {
					super();
					this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
				}
			}
		);
	});
</script>

<svelte:head>{@html early}</svelte:head>

<h1>late restore lab</h1>
<LateCard />
