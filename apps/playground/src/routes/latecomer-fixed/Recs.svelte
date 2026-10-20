<script lang="ts">
	import { getRecs } from '#lib/latecomer.remote.ts';
	const recs = await getRecs();
</script>

<span>{recs.name}</span>
