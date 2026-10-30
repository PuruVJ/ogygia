<script>
	// A remote query whose ARGUMENT is a custom transport type (hooks.js).
	import { sum_point } from './items.remote.js';
	import { Point } from './point.js';

	let x = $state(2);
</script>

<p data-point-sum>{await sum_point(new Point(x, 3))}</p>
<button data-point-bump onclick={() => x++}>bump</button>
