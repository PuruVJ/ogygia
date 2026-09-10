<script lang="ts">
	// The one island that reads `$page` — what makes the seed ship.
	import { page } from '$app/state';
</script>

<p data-page-greeting>{page.data.greeting}</p>
