<script>
	// An island using a remote `form` and the query it refreshes.
	import { add_item, list_items } from './items.remote.js';
</script>

<section data-add-item>
	<ul data-items>
		{#each await list_items() as item (item)}
			<li>{item}</li>
		{/each}
	</ul>
	<form {...add_item}>
		<input {...add_item.fields.text.as('text')} data-item-input />
		<button data-item-submit>add</button>
	</form>
</section>
