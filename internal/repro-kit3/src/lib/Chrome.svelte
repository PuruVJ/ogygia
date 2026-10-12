<script>
	// Site chrome as a LAKE: frozen server HTML holding islands and a hole. The layout serves a
	// csr=false page AND a csr=true page; the islands must hydrate on both.
	import Counter from './Counter.svelte' with { wake: 'load' };
	import PageProbe from './PageProbe.svelte' with { wake: 'load' };
	import AddItem from './AddItem.svelte' with { wake: 'load' };
	import PointSum from './PointSum.svelte' with { wake: 'load' };
	import Greeting from './Greeting.svelte' with { render: 'deferred' };
</script>

<div data-chrome>
	<Counter />
	<PageProbe />
	<AddItem />
	<PointSum />
	<Greeting salutation="Hello">
		{#snippet ogygiaFallback()}<p data-hole-fallback>loading…</p>{/snippet}
	</Greeting>
</div>
