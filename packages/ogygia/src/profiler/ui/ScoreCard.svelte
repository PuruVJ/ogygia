<script lang="ts">
	// THE OGYGIA PAGE SCORE, shown Lighthouse-style: one ring with the number + grade, then the
	// sub-scores it is made of (JS shipped, hydration, seed, server, layout) each on its own bar, and
	// the single biggest win to take first. Pure presentation — the number comes from page_score
	// (score.ts). Colour by score so the eye lands on the red bar.
	import type { PageScore } from '../score.js';

	let { score }: { score: PageScore } = $props();

	// Score → a token colour: green good, mint/accent fine, amber watch, red bad.
	function tone(n: number): string {
		if (n >= 90) return 'var(--good)';
		if (n >= 75) return 'var(--accent)';
		if (n >= 50) return 'var(--warn)';
		return 'var(--bad)';
	}
	const ring = $derived(tone(score.score));
</script>

<section class="scorecard" aria-label="ogygia page score">
	<div class="ring-wrap">
		<div
			class="ring"
			style="--pct:{score.score};--ring:{ring}"
			role="img"
			aria-label="score {score.score} of 100, grade {score.grade}"
		>
			<div class="ring-fill">
				<b style="color:{ring}">{score.score}</b>
				<span class="grade" style="color:{ring}">{score.grade}</span>
			</div>
		</div>
		<div class="ring-cap">
			<h2>ogygia score</h2>
			<p class="hint">
				scored on what ogygia controls — least JS, clean hydration, small seed &amp; server render,
				stable layout. Missing measurements (no visits, no server timing) drop out, they don't cost
				points.
			</p>
			{#if score.worst}
				<p class="win">
					<span class="win-k" style="color:{tone(score.worst.score)}">Biggest win</span>
					{score.worst.note}
				</p>
			{/if}
		</div>
	</div>

	<div class="cats">
		{#each score.categories as c (c.key)}
			{@render bar(c)}
		{/each}
	</div>
</section>

{#snippet bar(c)}
	<div class="cat" title={c.note}>
		<div class="cat-head">
			<span class="cat-label">{c.label}</span>
			<span class="cat-value">{c.value}</span>
			<span class="cat-score" style="color:{tone(c.score)}">{c.score}</span>
		</div>
		<div class="track"><div class="meter" style="width:{c.score}%;background:{tone(c.score)}"></div></div>
	</div>
{/snippet}

<style>
	.scorecard {
		display: grid;
		grid-template-columns: minmax(280px, 1fr) minmax(0, 1.4fr);
		gap: 1.5rem 2rem;
		align-items: center;
		padding: 1.25rem 1.5rem;
		margin: 1rem 0 1.5rem;
		background: var(--bg-raised);
		border: 1px solid var(--line);
		border-radius: var(--r-lg, 12px);
	}
	.ring-wrap {
		display: flex;
		gap: 1.25rem;
		align-items: center;
	}
	.ring {
		flex: none;
		width: 108px;
		height: 108px;
		border-radius: 50%;
		background: conic-gradient(var(--ring) calc(var(--pct) * 1%), var(--line) 0);
		display: grid;
		place-items: center;
	}
	.ring-fill {
		width: 84px;
		height: 84px;
		border-radius: 50%;
		background: var(--bg-panel, var(--bg-sunken));
		display: grid;
		place-items: center;
		line-height: 1;
	}
	.ring-fill b {
		font-size: 2rem;
		font-variant-numeric: tabular-nums;
	}
	.grade {
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.08em;
	}
	.ring-cap h2 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
	}
	.ring-cap .hint {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.8rem;
		line-height: 1.4;
	}
	.win {
		margin: 0.6rem 0 0;
		font-size: 0.82rem;
		color: var(--text);
		line-height: 1.4;
	}
	.win-k {
		font-weight: 700;
		margin-right: 0.35rem;
	}
	.cats {
		display: grid;
		gap: 0.6rem;
		min-width: 0;
	}
	.cat-head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.82rem;
	}
	.cat-label {
		font-weight: 600;
	}
	.cat-value {
		margin-left: auto;
		color: var(--text-faint);
		font-family: var(--font-mono);
		font-size: 0.75rem;
	}
	.cat-score {
		font-variant-numeric: tabular-nums;
		font-weight: 700;
		width: 2ch;
		text-align: right;
	}
	.track {
		height: 6px;
		margin-top: 0.25rem;
		border-radius: 999px;
		background: var(--bg-sunken);
		overflow: hidden;
	}
	.meter {
		height: 100%;
		border-radius: 999px;
		transition: width 0.4s ease;
	}
	@media (max-width: 640px) {
		.scorecard {
			grid-template-columns: 1fr;
		}
	}
</style>
