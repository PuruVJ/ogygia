<script>
	import { getContext } from 'svelte';
	/** @type {(n: number) => string} */
	const fmt = getContext('fmt');
	let out = $state('');
</script>

<button data-dollar-btn onclick={() => (out = fmt(100))}>format</button>
<p data-dollar-out>{out}</p>
