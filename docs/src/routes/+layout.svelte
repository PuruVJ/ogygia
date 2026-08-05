<script lang="ts">
	import '../app.css';
	import { OgygiaRouter } from 'ogygia';

	let { children } = $props();
</script>

<OgygiaRouter />
{@render children()}
