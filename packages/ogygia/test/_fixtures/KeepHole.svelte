<script lang="ts">
	// A server island that always keeps the page's fallback (an anonymous visitor's "nothing to add").
	import { keepFallback } from '../../src/keep-fallback.js';
	keepFallback();
</script>

<p>never rendered</p>
