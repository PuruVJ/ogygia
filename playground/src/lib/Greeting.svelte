<script lang="ts">
	import { personalGreeting } from '$lib/server-greeting.remote';

	let { salutation = 'Hi' }: { salutation?: string } = $props();

	// await OUTSIDE any pending boundary -> fully resolved during the (deferred) server
	// render. This runs on the `/_islands` endpoint, not during the initial page SSR.
	const data = await personalGreeting();
</script>

<div class="greeting" data-server-greeting>
	<strong>{salutation}, {data.name}!</strong>
	<span class="ts" data-server-at>rendered on the server at {data.at}</span>
</div>

<style>
	.greeting {
		padding: 12px 16px;
		border: 2px solid rebeccapurple;
		border-radius: 8px;
		background: #f6f2fb;
	}
	.greeting .ts {
		display: block;
		margin-top: 4px;
		color: rebeccapurple;
		font-size: 0.8em;
	}
</style>
