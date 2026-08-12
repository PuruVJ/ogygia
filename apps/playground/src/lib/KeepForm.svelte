<script lang="ts">
	// An island form. Half-filled fields survive SPA navigation (ambient continuity). The
	// `data-ogygia-no-keep` field opts OUT — it starts blank on every visit.
	let name = $state('');
	let subscribe = $state(false);
	let otp = $state('');
</script>

<div class="island" data-keep-form>
	<input data-kf-name placeholder="name" bind:value={name} />
	<label><input data-kf-sub type="checkbox" bind:checked={subscribe} /> subscribe</label>
	<input data-kf-otp data-ogygia-no-keep placeholder="one-time code" bind:value={otp} />
	<span data-kf-echo>{name}{subscribe ? ' ✓' : ''}</span>
</div>
