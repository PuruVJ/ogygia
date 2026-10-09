<script>
	// an island INSIDE a package-shipped router page (glob-declared: ./src/pages/**/*.svelte)
	import Tally from '../widgets/Tally.svelte' with { wake: 'load' };
	let { data } = $props();
</script>

<article data-pkg-page>
	<h1>Shipped route: {data.title}</h1>
	<Tally start={10} />
</article>
