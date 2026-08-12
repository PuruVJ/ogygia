<script lang="ts">
	// Renders the committed ogygiaBench results (bench/results/latest.json, copied here) as charts.
	// Headline: client JS vs post length — islands stay flat, whole-page hydration climbs.
	import data from '$lib/bench/results.json';

	type Row = {
		post: string;
		words: number;
		jsRaw: number;
		jsBr: number;
		htmlRaw: number;
		htmlBr: number;
		score: number;
		lcp: number;
		cls: number;
		tbt: number;
		evalMs: number;
		dom: number;
	};
	type Fw = { id: string; approach: string; rows: Row[]; avg: Row };

	const frameworks = data.frameworks as unknown as Fw[];
	const posts = data.posts as { id: string; words: number }[];

	const COLOR: Record<string, string> = {
		ogygia: '#2563eb',
		sveltekit: '#ff3e00',
		astro: '#7c3aed',
		mochi: '#db2777'
	};
	const color = (id: string) => COLOR[id] ?? '#888';
	const kb = (n: number) => n / 1024;

	// ── growth line chart (JS raw KB vs post word count) ──
	const W = 640,
		H = 320,
		P = { t: 20, r: 96, b: 44, l: 52 };
	const xs = posts.map((p) => p.words);
	const xMin = Math.min(...xs),
		xMax = Math.max(...xs);
	const allJs = frameworks.flatMap((f) => f.rows.map((r) => kb(r.jsRaw)));
	const yMax = Math.ceil(Math.max(...allJs) / 50) * 50;
	const x = (w: number) => P.l + ((w - xMin) / (xMax - xMin)) * (W - P.l - P.r);
	const y = (v: number) => H - P.b - (v / yMax) * (H - P.t - P.b);
	const line = (f: Fw) =>
		f.rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.words).toFixed(1)},${y(kb(r.jsRaw)).toFixed(1)}`).join(' ');
	const yTicks = Array.from({ length: 5 }, (_, i) => Math.round((yMax / 4) * i));

	// ── metric bars ──
	const metrics = [
		{ key: 'jsBr', label: 'Client JS (brotli)', unit: 'KB', get: (f: Fw) => kb(f.rows[0].jsBr), lowerBetter: true },
		{ key: 'score', label: 'Lighthouse score', unit: '', get: (f: Fw) => f.avg.score, lowerBetter: false, max: 100 },
		{ key: 'lcp', label: 'LCP (avg)', unit: 's', get: (f: Fw) => f.avg.lcp / 1000, lowerBetter: true },
		{ key: 'cls', label: 'CLS (avg)', unit: '', get: (f: Fw) => f.avg.cls, lowerBetter: true },
		{ key: 'evalMs', label: 'JS eval (median)', unit: 'ms', get: (f: Fw) => median(f.rows.map((r) => r.evalMs)), lowerBetter: true }
	];
	function median(a: number[]) {
		const s = [...a].sort((x, y) => x - y);
		return s[Math.floor(s.length / 2)];
	}
	const fmt = (v: number, u: string) => (u === 's' ? v.toFixed(1) : u === '' ? (v < 1 ? v.toFixed(3) : Math.round(v)) : Math.round(v)) + (u ? ' ' + u : '');
</script>

<div class="bench">
	<figure class="growth">
		<figcaption>Client JavaScript as the post grows longer — islands stay flat; whole-page hydration climbs.</figcaption>
		<svg viewBox="0 0 {W} {H}" role="img" aria-label="JS payload vs post length">
			{#each yTicks as t}
				<line class="grid" x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} />
				<text class="axis" x={P.l - 8} y={y(t) + 4} text-anchor="end">{t}</text>
			{/each}
			<text class="axis unit" x={14} y={P.t} transform="rotate(-90 14 {H / 2})">JS KB (uncompressed)</text>
			{#each posts as p}
				<text class="axis" x={x(p.words)} y={H - P.b + 18} text-anchor="middle">{Math.round(p.words / 1000)}k</text>
			{/each}
			<text class="axis" x={(P.l + W - P.r) / 2} y={H - 6} text-anchor="middle">words in post</text>
			{#each frameworks as f}
				<path class="ln" d={line(f)} stroke={color(f.id)} />
				{#each f.rows as r}
					<circle cx={x(r.words)} cy={y(kb(r.jsRaw))} r="3.5" fill={color(f.id)} />
				{/each}
				<text class="lbl" x={W - P.r + 6} y={y(kb(f.rows.at(-1)!.jsRaw)) + 4} fill={color(f.id)}>{f.id}</text>
			{/each}
		</svg>
	</figure>

	<div class="metrics">
		{#each metrics as m}
			{@const vals = frameworks.map((f) => ({ id: f.id, v: m.get(f) }))}
			{@const max = (m.max ?? Math.max(...vals.map((v) => v.v)) * 1.15) || 1}
			<figure class="bar">
				<figcaption>{m.label}</figcaption>
				{#each vals as { id, v }}
					<div class="row">
						<span class="name" style="color:{color(id)}">{id}</span>
						<div class="track"><div class="fill" style="width:{(v / max) * 100}%;background:{color(id)}"></div></div>
						<span class="val">{fmt(v, m.unit)}</span>
					</div>
				{/each}
			</figure>
		{/each}
	</div>
	<p class="src">
		Mobile Lighthouse, simulated throttling. Sizes are brotli/raw of all JS the page loads. Method ported from
		<a href="https://github.com/khromov/interactive-blogs-benchmark">khromov/interactive-blogs-benchmark</a>. Reproduce: <code>pnpm run e2e</code> is separate; see <code>bench/</code>.
	</p>
</div>

<style>
	.bench {
		margin: 1.5rem 0;
		font-size: 0.9rem;
	}
	svg {
		width: 100%;
		height: auto;
	}
	.growth figcaption,
	.bar figcaption {
		font-weight: 600;
		margin-bottom: 0.5rem;
	}
	.grid {
		stroke: color-mix(in oklab, currentColor 12%, transparent);
	}
	.axis {
		fill: color-mix(in oklab, currentColor 55%, transparent);
		font-size: 11px;
	}
	.ln {
		fill: none;
		stroke-width: 2.5;
	}
	.lbl {
		font-size: 12px;
		font-weight: 600;
	}
	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
		gap: 1.25rem 2rem;
		margin-top: 1.5rem;
	}
	.bar .row {
		display: grid;
		grid-template-columns: 4.5rem 1fr auto;
		align-items: center;
		gap: 0.5rem;
		margin: 0.35rem 0;
	}
	.name {
		font-weight: 600;
		font-size: 0.82rem;
	}
	.track {
		background: color-mix(in oklab, currentColor 8%, transparent);
		border-radius: 4px;
		height: 0.75rem;
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: 4px;
	}
	.val {
		font-variant-numeric: tabular-nums;
		font-size: 0.8rem;
		min-width: 4rem;
		text-align: right;
	}
	.src {
		margin-top: 1.5rem;
		font-size: 0.78rem;
		opacity: 0.7;
	}
</style>
