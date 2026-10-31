<script lang="ts">
	// THE ELEMENT-COUNT LAB for the devtools answer key. The plant: DenseList, an island of ~3,600
	// elements. /dt-dom-static is the same list as plain page markup (named, but never an island);
	// /dt-big (~1,000 elements) stays quiet.
	import DenseList from '$lib/dtdom/DenseList.svelte' with { wake: 'load' };
</script>

<h1>element-count lab</h1>
<DenseList rows={1200} />
