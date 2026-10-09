/**
 * A Windows-style "determinate-ish" progress: crawls forward fast at first, eases toward 95% with the
 * occasional burst, then snaps to 100% when the real work finishes. There is no true percentage to
 * report — the profile endpoint just works until it's done — so this is a timed illusion, the standard
 * "something is happening" reassurance bar. Call `start()` when the request goes out, `finish()` when
 * it resolves (it awaits one paint at 100% before returning), `fail()` on error.
 */
export function fake_progress() {
	let value = $state(0);
	let running = $state(false);
	let timer: ReturnType<typeof setInterval> | undefined;

	function tick() {
		if (value >= 95) return;
		const gap = 95 - value;
		// base easing (fast when far from 95, slow as it nears) + an occasional "then a lot" jump
		const burst = Math.random() < 0.18 ? gap * 0.14 : 0;
		value = Math.min(95, value + gap * 0.045 + burst + 0.5);
	}

	return {
		get value() {
			return value;
		},
		get running() {
			return running;
		},
		start() {
			clearInterval(timer);
			value = 0;
			running = true;
			timer = setInterval(tick, 170);
		},
		async finish() {
			clearInterval(timer);
			value = 100;
			// let the 100% frame paint before the caller swaps the view
			await new Promise((r) => setTimeout(r, 420));
			running = false;
		},
		fail() {
			clearInterval(timer);
			running = false;
			value = 0;
		}
	};
}
