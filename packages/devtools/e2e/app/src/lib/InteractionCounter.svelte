<script lang="ts">
	// wake:'interaction' island. `hydratedBy()` tells it HOW it woke — for an interaction wake
	// the first click is a replay (untrusted gesture), so gesture-gated APIs would be blocked.
	import { hydratedBy } from 'ogygia';

	let n = $state(0);
	let text = $state('');
	const woke = hydratedBy();
	// The replayed click carries isTrusted=false — surface it so the e2e can assert the semantics.
	let lastTrusted: boolean | null = $state(null);
</script>

<div class="island" data-interaction-counter data-woke={woke}>
	<button
		data-i-btn
		onclick={(e) => {
			n += 1;
			lastTrusted = e.isTrusted;
		}}
	>
		clicks: <span data-i-count>{n}</span>
	</button>
	<span data-i-trusted>{lastTrusted === null ? 'none' : String(lastTrusted)}</span>
	<input data-i-input placeholder="type before hydrate" bind:value={text} />
	<span data-i-typed>{text}</span>
</div>
