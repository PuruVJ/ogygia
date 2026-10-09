<script lang="ts">
	// A second island on the same shared chunk (version.ts): both entries must move when it moves.
	import { VERSION } from './version.js';
	let ran = $state('');
	$effect(() => {
		ran = VERSION;
	});
</script>

<p data-probe="twin" data-ran={ran || undefined}>twin: {ran || 'asleep'}</p>
