<script lang="ts">
	import { getTemperature } from '$lib/greetings.remote';
	import { Temperature } from '../hooks';
</script>

<div class="island" data-transport-probe>
	<svelte:boundary>
		{#await getTemperature() then temp}
			<span data-transport-ok>{temp instanceof Temperature}</span>
			<span data-transport-value>{temp.celsius}°C / {temp.fahrenheit}°F</span>
		{/await}
		{#snippet pending()}<span>loading temperature…</span>{/snippet}
	</svelte:boundary>
</div>
