// THE SHARED INTERSECTION OBSERVER (runtime/observe.ts), in a real browser. The hydration
// scheduler's viewport snapshot and a `wake:'visible'` island both watch the island at the default
// margin; with one callback per element the wake replaced the snapshot, and every visible island
// then sat out the scheduler's whole 48 ms snapshot wait (62–84 ms late on a scroll, with nothing
// ahead of it). Both must hear every change, and one leaving must not silence the other.
import { expect, test } from 'vitest';
import { observe, once_visible } from '../../src/runtime/observe.js';
import { hydrate_turn, register_region, unregister_region } from '../../src/runtime/schedule.js';

const box = () => {
	const el = document.createElement('div');
	el.style.cssText = 'width:10px;height:10px';
	document.body.append(el);
	return el;
};
const settle = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));

test('two watchers of one element at one margin both hear it; one stopping leaves the other', async () => {
	const el = box();
	const a: boolean[] = [];
	const b: boolean[] = [];
	const stop_a = observe(el, '0px', (v) => a.push(v));
	const stop_b = observe(el, '0px', (v) => b.push(v));
	await settle();
	expect(a).toEqual([true]);
	expect(b).toEqual([true]);
	stop_a();
	el.style.marginTop = '5000px'; // off screen
	await settle();
	expect(a).toEqual([true]);
	expect(b).toEqual([true, false]);
	stop_b();
	el.remove();
});

test('a watcher that joins late gets the last known state (the browser will not report it again)', async () => {
	const el = box();
	const first: boolean[] = [];
	const stop = observe(el, '0px', (v) => first.push(v));
	await settle();
	expect(first).toEqual([true]);
	let fired = false;
	const stop_visible = once_visible(el, '0px', () => (fired = true));
	await settle();
	expect(fired).toBe(true); // already on screen: it wakes, and does not wait for a change
	stop();
	stop_visible();
	el.remove();
});

test('a visible island woken on screen gets its turn without the 48 ms snapshot wait', async () => {
	const el = box();
	register_region(el); // the scheduler's snapshot (at connect)
	let woke_at = 0;
	once_visible(el, '0px', () => (woke_at = performance.now())); // the island's wake, same margin
	await expect.poll(() => woke_at > 0).toBe(true);
	// the turn itself (the poll above checks every 50 ms: time from the ask, not the wake)
	const asked = performance.now();
	await hydrate_turn(el);
	const waited = performance.now() - asked;
	expect(waited, `turn came ${Math.round(waited)} ms after the ask`).toBeLessThan(30);
	unregister_region(el);
	el.remove();
});
