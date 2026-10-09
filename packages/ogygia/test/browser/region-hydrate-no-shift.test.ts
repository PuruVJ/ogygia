// BOX-STABILITY THROUGH WAKE, measured the way the browser scores it. An island's hydrate — the repair,
// Svelte's claim, or its recovery re-render when the claim fails — runs as ONE synchronous step
// (runtime/hydrate-core.ts `hydrate_island`: no `await` between the lake lift and the restore), so no
// painted frame can show the region empty or its content moved, and ogygia does nothing to the
// region's box. REGRESSION: a former "hold" set the region to `display:block` + `min-height` for one
// painted frame to guard against a detach frame that never paints. That style flip re-laid-out the
// region under the page's CSS (an inline region is block-in-inline; `block` changes its children's
// containing block and anonymous boxes) and cost a customer hero a 0.69 layout shift.
//
// Real Chromium: layout-shift entries (a positive control proves the observer reports), the island's
// content position sampled on EVERY animation frame, and every write to the region's `style`
// attribute recorded — across layouts where the region sits in block flow, inline flow, and around a
// percentage-sized hero with content below it.
import { expect, inject, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';

const REGION = 'ogygia-region[entry$="Counter.svelte"]';
const counter = () => decodeURIComponent(escape(atob(inject('counter_ssr_b64'))));
const frames = (n: number) =>
	new Promise<void>((resolve) => {
		let i = 0;
		const tick = () => (++i >= n ? resolve() : requestAnimationFrame(tick));
		requestAnimationFrame(tick);
	});

type Probe = { cls: number; tops: Set<number>; style_writes: number };

/** Run `action`, then observe 8 frames: layout shifts, the island content's top on each frame, and
 *  every write to the region's `style` attribute. */
async function probe(action: () => Promise<void> | void): Promise<Probe> {
	let cls = 0;
	const po = new PerformanceObserver((list) => {
		for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>)
			if (!e.hadRecentInput) cls += e.value;
	});
	po.observe({ type: 'layout-shift' });
	const region = document.querySelector(REGION);
	let style_writes = 0;
	const mo = new MutationObserver((records) => {
		for (const r of records) if (r.attributeName === 'style') style_writes++;
	});
	if (region) mo.observe(region, { attributes: true, attributeFilter: ['style'] });
	const tops = new Set<number>();
	let sampling = true;
	const sample = () => {
		const p = document.querySelector(`${REGION} p`);
		tops.add(p ? Math.round(p.getBoundingClientRect().top) : -1); // -1 = the content was missing
		if (sampling) requestAnimationFrame(sample);
	};
	requestAnimationFrame(sample);
	await action();
	await frames(8);
	sampling = false;
	await frames(2);
	po.disconnect();
	mo.disconnect();
	return { cls, tops, style_writes };
}

async function hydrate(): Promise<void> {
	bootDev();
	for (let i = 0; i < 200 && !document.querySelector(`${REGION}[data-hydrated]`); i++) await frames(1);
	expect(document.querySelector(`${REGION}[data-hydrated]`), 'the island hydrated').not.toBeNull();
}

const LAYOUTS: Array<{ name: string; style: string; page: (island: string) => string }> = [
	{
		name: 'block flow, content above and below',
		style: 'ogygia-region p{min-height:374px;margin:0}',
		page: (i) =>
			`<div style="width:800px"><nav style="height:56px">crumbs</nav>${i}<footer style="height:80px">below</footer></div>`
	},
	{
		name: 'inline flow (text around the region)',
		style: 'ogygia-region p{min-height:200px;margin:0}',
		page: (i) => `<div style="width:800px">lead text ${i} tail text<footer style="height:80px">below</footer></div>`
	},
	{
		name: 'percentage-sized hero (its containing block matters)',
		style: '.wrap{width:800px;height:1200px} ogygia-region p{margin:0;height:40%}',
		page: (i) =>
			`<div class="wrap"><nav style="height:56px">crumbs</nav>${i}<footer style="height:80px">below</footer></div>`
	}
];

test('control: the layout-shift observer reports a real shift', async () => {
	document.body.innerHTML = '<div style="width:800px"><p id="t" style="height:300px;margin:0">x</p></div>';
	await frames(3);
	const { cls } = await probe(() => {
		const d = document.createElement('div');
		d.style.height = '100px';
		document.querySelector('#t')!.before(d);
	});
	expect(cls, 'without this, the zeros below would prove nothing').toBeGreaterThan(0);
});

for (const layout of LAYOUTS) {
	test(`${layout.name}: hydrating shifts nothing, never paints the island empty, never styles the region`, async () => {
		document.body.innerHTML = `<style>${layout.style}</style>` + layout.page(counter());
		await frames(3);
		const before = Math.round(document.querySelector(`${REGION} p`)!.getBoundingClientRect().top);
		const { cls, tops, style_writes } = await probe(hydrate);
		expect(cls, 'no layout shift').toBe(0);
		expect([...tops], 'the content is present, at the same place, in every painted frame').toEqual([before]);
		expect(style_writes, "the runtime never touches the region's box").toBe(0);
	});
}
