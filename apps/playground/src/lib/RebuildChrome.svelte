<script lang="ts">
	// Site chrome with two deferred holes, imported PLAINLY by a csr=true page (hole-kit-rebuild).
	// A route host on a csr=true page has its marks stripped (everything is Kit's there), but a
	// shared component keeps them: its holes stay real `<ogygia-region render="defer">`s with a
	// signed address, and the runtime ships to fetch them — the customer's header shape. When Kit
	// gives up hydrating the document and mounts it fresh, the client leg renders these holes
	// again with NO address; e2e/hole-kit-rebuild.spec.ts proves they still fill.
	import Greeting from './Greeting.svelte' with { render: 'deferred' };
	import RebuildBox from './RebuildBox.svelte' with { render: 'deferred' };
</script>

<div data-rebuild-static-hole>
	<Greeting salutation="Rebuilt">
		{#snippet ogygiaFallback()}<p data-rebuild-fallback>loading greeting…</p>{/snippet}
	</Greeting>
</div>
<div data-rebuild-island-hole>
	<RebuildBox start={5}>
		{#snippet ogygiaFallback()}<p data-rebuild-box-fallback>loading box…</p>{/snippet}
	</RebuildBox>
</div>
