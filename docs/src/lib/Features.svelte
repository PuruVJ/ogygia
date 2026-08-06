<script lang="ts">
	import { FEATURES } from '$lib/features';
</script>

<section id="features" class="features" aria-labelledby="features-heading">
	<div class="shell">
		<h2 id="features-heading">Features</h2>
		<p class="features-lede">We’ve got them.</p>
		<ul class="features-list">
			{#each FEATURES as feature (feature)}
				<li>{feature}</li>
			{/each}
		</ul>
	</div>
</section>
