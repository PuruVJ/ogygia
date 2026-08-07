<script lang="ts">
	// Demo island: header/children content lives inside the component (portable bindings
	// cannot hoist host snippets). Props carry the outer values.
	let { title, y = 0 }: { title: string; y?: number } = $props();
</script>

<div class="island" data-snippet-children>
	<strong>{title}</strong>
	<div data-header><em>header snippet sees outer var y = {y}</em></div>
	<div data-children><span>children content, y doubled = {y * 2}</span></div>
</div>
