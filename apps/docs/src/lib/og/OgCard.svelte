<svelte:options css="injected" />

<script lang="ts">
	// Self-contained OG card, rendered to HTML on the server then rasterised by satori → resvg.
	// `css="injected"` inlines this component's CSS into the render output so satori can consume it
	// (satori only understands its flexbox CSS subset — keep the rules below within it).
	let {
		title = 'SSR islands for SvelteKit',
		category = '',
		home = false
	}: { title?: string; category?: string; home?: boolean } = $props();

	const palm =
		'<path d="M4 26 Q16 20 28 26"/><path d="M16 21.5 Q14.5 14 17 8"/>' +
		'<path d="M17 8 Q12 5 7.5 7"/><path d="M17 8 Q17 4 21 3.5"/><path d="M17 8 Q22 6.5 25.5 9.5"/>';
</script>

<div class="card">
	<div class="rule"></div>
	<div class="palm-bg">
		<svg width="600" height="600" viewBox="0 0 32 32" fill="none" stroke="#6fe3b0" stroke-width="1.4" stroke-linecap="round">{@html palm}</svg>
	</div>

	{#if home}
		<!-- home: the brand IS the hero -->
		<div class="hero">
			<div class="hero-lockup">
				<svg width="104" height="104" viewBox="0 0 32 32" fill="none" stroke="#6fe3b0" stroke-width="2.1" stroke-linecap="round">{@html palm}</svg>
				<span class="hero-word">ogygia</span>
			</div>
			<span class="hero-tag">SSR islands for SvelteKit</span>
		</div>
		<div class="foot">
			<span class="foot-mono">ogygia.puruvj.dev</span>
			<span class="foot-mono">oh-jee-jee-ya</span>
		</div>
	{:else}
		<div class="brand">
			<svg width="46" height="46" viewBox="0 0 32 32" fill="none" stroke="#6fe3b0" stroke-width="2.25" stroke-linecap="round">{@html palm}</svg>
			<span class="brand-word">ogygia</span>
		</div>

		<div class="mid">
			{#if category}
				<div class="chip-row"><span class="chip">{category}</span></div>
			{/if}
			<div class="title" class:title-long={title.length > 40}>{title}</div>
		</div>

		<div class="foot">
			<span class="foot-mono">ogygia.puruvj.dev</span>
			<span class="foot-mono">SSR islands for SvelteKit</span>
		</div>
	{/if}
</div>

<style>
	.card {
		position: relative;
		width: 1200px;
		height: 630px;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 70px 76px;
		background: #060907;
		background-image: radial-gradient(1000px 500px at 100% 0%, rgba(111, 227, 176, 0.13), rgba(6, 9, 7, 0) 60%);
		overflow: hidden;
		font-family: 'Newsreader';
	}
	.rule {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		width: 1200px;
		height: 6px;
		background: #6fe3b0;
	}
	.palm-bg {
		position: absolute;
		right: -70px;
		bottom: -110px;
		display: flex;
		opacity: 0.05;
	}

	/* home hero */
	.hero {
		display: flex;
		flex-direction: column;
		flex-grow: 1;
		justify-content: center;
		gap: 22px;
	}
	.hero-lockup {
		display: flex;
		align-items: center;
		gap: 28px;
	}
	.hero-word {
		font-family: 'Newsreader';
		font-style: italic;
		font-weight: 600;
		font-size: 150px;
		line-height: 1;
		letter-spacing: -0.02em;
		color: #e9f1ec;
	}
	.hero-tag {
		display: flex;
		font-family: 'JetBrains Mono';
		font-weight: 500;
		font-size: 34px;
		letter-spacing: -0.01em;
		color: #9bb8ab;
		padding-left: 6px;
	}

	/* titled (docs) pages */
	.brand {
		display: flex;
		align-items: center;
		gap: 15px;
	}
	.brand-word {
		font-family: 'Newsreader';
		font-style: italic;
		font-weight: 600;
		font-size: 40px;
		color: #e9f1ec;
		letter-spacing: -0.01em;
	}
	.mid {
		display: flex;
		flex-direction: column;
		gap: 26px;
		max-width: 1010px;
	}
	.chip-row {
		display: flex;
	}
	.chip {
		display: flex;
		font-family: 'JetBrains Mono';
		font-weight: 500;
		font-size: 22px;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #6fe3b0;
		padding: 9px 16px;
		border: 1px solid rgba(111, 227, 176, 0.35);
		border-radius: 999px;
		background: rgba(111, 227, 176, 0.06);
	}
	.title {
		display: flex;
		font-family: 'Newsreader';
		font-weight: 600;
		font-size: 76px;
		line-height: 1.04;
		letter-spacing: -0.025em;
		color: #e9f1ec;
	}
	.title-long {
		font-size: 62px;
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.foot-mono {
		display: flex;
		font-family: 'JetBrains Mono';
		font-weight: 500;
		font-size: 24px;
		color: #7f9b8e;
	}
</style>
