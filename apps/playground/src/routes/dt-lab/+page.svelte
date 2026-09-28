<script lang="ts">
	// The devtools Page tab's ANSWER KEY page (internal/bench/devtools-answer-key.mjs): every PLANTED
	// island has one problem the browser can measure; every DECOY is healthy and must never be named.
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
	import Clock from '$lib/dtlab/Clock.svelte' with { wake: 'load' };
	import Grower from '$lib/dtlab/Grower.svelte' with { wake: 'load' };
	import Heavy from '$lib/dtlab/Heavy.svelte' with { wake: 'load' };
	import Broken from '$lib/dtlab/Broken.svelte' with { wake: 'load' };
	import LateClick from '$lib/dtlab/LateClick.svelte' with { wake: 'visible' };
	import BelowEager from '$lib/dtlab/BelowEager.svelte' with { wake: 'load' };
	import BelowLazy from '$lib/dtlab/BelowLazy.svelte' with { wake: 'visible' };
	import Edited from '$lib/dtlab/Edited.svelte' with { wake: 'visible' };
	// PLANTED healed: a page script edits the Edited island before it wakes
	const edit = `<script>document.querySelector('[data-dt="edited"] button').textContent = 'edited by a page script';<\/script>`;
	import OnClick from '$lib/dtlab/OnClick.svelte' with { wake: 'interaction' };

	// PLANTED long-tasks: a page script (not an island) holds the main thread after load.
	const busy = `<script>addEventListener('load', () => setTimeout(() => { const u = performance.now() + 220; while (performance.now() < u); }, 400));<\/script>`;
</script>

<h1>devtools lab</h1>
<Healthy />
<Grower />
<Clock />
<Heavy />
<Broken />
<OnClick />

<div style="height: 1600px" aria-hidden="true"></div>
<BelowLazy />
<BelowEager />
<div style="height: 400px" aria-hidden="true"></div>
<LateClick />
<div style="height: 400px" aria-hidden="true"></div>
{@html busy}
<div style="height: 400px" aria-hidden="true"></div>
<Edited />
{@html edit}
