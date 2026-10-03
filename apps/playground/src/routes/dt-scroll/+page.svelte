<script lang="ts">
	// THE SCROLL-LISTENER LAB for the devtools answer key. Wheelie's wheel listener holds its box's
	// scrolling (the plant); Smooth's are passive (the decoys). Only Wheelie is named.
	import Wheelie from '$lib/dtscroll/Wheelie.svelte' with { wake: 'load' };
	import Smooth from '$lib/dtscroll/Smooth.svelte' with { wake: 'load' };
</script>

<h1>scroll listener lab</h1>
<Wheelie />
<Smooth />
