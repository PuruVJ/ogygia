<script lang="ts">
	// THE BIG ISLAND LAB for the devtools answer key: two islands with ~40 KB of markup each. BigList's
	// last attribute differs between the server and the browser; BigSteady's never does. The
	// markup-changed finding must name BigList and quote its `data-track`, never BigSteady.
	import BigList from '$lib/dtbig/BigList.svelte' with { wake: 'load' };
	import BigSteady from '$lib/dtbig/BigSteady.svelte' with { wake: 'load' };
</script>

<h1>big island lab</h1>
<BigList rows={500} />
<BigSteady rows={500} />
