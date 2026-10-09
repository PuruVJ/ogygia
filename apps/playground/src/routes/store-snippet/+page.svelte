<script lang="ts">
	// Store auto-subscriptions inside a snippet that crosses into an island (the se.com CI shape).
	// `$country` / `$language` are host-scoped sugar: the compiler must capture the subscription
	// VALUE at the host and rewrite the crossed body — never emit `$country` verbatim into the
	// runes-mode synth entry (that used to kill the build inside virtual:ogygia/island/…).
	// The nested Bumper island proves the crossed copy still comes ALIVE.
	import PortableBar from '$lib/PortableBar.svelte' with { wake: 'load' };
	import Bumper from '$lib/Bumper.svelte' with { wake: 'load' };
	import { country, language } from '$lib/sub-stores';

	const label = 'locale';
</script>

<nav><a href="/">Home</a></nav>
<h1 data-static>Store subscriptions across a snippet boundary</h1>
<p data-host-read>host reads {$country} directly</p>

<PortableBar>
	{#snippet actions()}
		<span data-cc>{$country}</span>
		<span data-loc>{label}: {`${$language}-${$country.toUpperCase()}`}</span>
		<Bumper start={7} />
	{/snippet}
</PortableBar>
