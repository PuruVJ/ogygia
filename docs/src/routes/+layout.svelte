<script lang="ts">
	import '../app.css';
	import { ClientRouter } from 'ogygia';

	let { children } = $props();
</script>

<ClientRouter />
{@render children()}
