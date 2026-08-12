<script lang="ts">
	// A rich, INTERACTIVE result the server picks and fills — hydrates after it lands.
	let { name, tagline, lang, stars } = $props<{
		name: string;
		tagline: string;
		lang: string;
		stars: number;
	}>();
	let starred = $state(false);
</script>

<article class="pkg-card">
	<header class="pkg-card-head">
		<h4 class="pkg-card-name">{name}</h4>
		<span class="pkg-card-lang">{lang}</span>
	</header>
	<p class="pkg-card-tagline">{tagline}</p>
	<button type="button" class="pkg-card-star" class:on={starred} onclick={() => (starred = !starred)}>
		{starred ? '★' : '☆'} {stars + (starred ? 1 : 0)}
	</button>
</article>

<style>
	.pkg-card { border: 1px solid var(--doc-border, #3a3a3a); border-radius: 12px; padding: 1rem 1.1rem; display: grid; gap: 0.5rem; }
	.pkg-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
	.pkg-card-name { margin: 0; font-size: 1.1rem; }
	.pkg-card-lang { font-size: 0.75rem; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
	.pkg-card-tagline { margin: 0; opacity: 0.85; }
	.pkg-card-star { justify-self: start; padding: 0.35rem 0.7rem; border-radius: 999px; border: 1px solid currentColor; background: none; color: inherit; cursor: pointer; font: inherit; }
	.pkg-card-star.on { color: #f5b301; }
</style>
