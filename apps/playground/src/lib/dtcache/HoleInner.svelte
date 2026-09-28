<script lang="ts">
	// The island inside the hole's answer: stamps which build's code woke it.
	import { VERSION } from './version.js';
	let ran = $state('');
	$effect(() => {
		ran = VERSION;
	});
</script>

<p data-probe="hole" data-ran={ran || undefined}>hole: {ran || 'asleep'}</p>
