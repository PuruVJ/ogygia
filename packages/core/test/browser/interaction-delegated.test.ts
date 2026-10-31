// `wake:'interaction'` DELEGATION (runtime/interaction.ts): the wake + warm listeners live on the
// document, once; an event resolves to the nearest ARMED region above its target. Semantics per
// region are what its own capture listeners gave it: first event wakes (once), clicks before the
// island is live are canceled and queued, the pointer crossing in warms once, disarm forgets it.
import { expect, test } from 'vitest';
import { arm_interaction } from '../../src/runtime/interaction.ts';

const region = (id: string, inner = '<button>go</button>') =>
	`<ogygia-region id="${id}" wake="interaction" entry="/x.js">${inner}</ogygia-region>`;

const defer = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

test('an event inside an armed region wakes THAT region only, once; the pointer warms once', async () => {
	document.body.innerHTML = region('one') + region('two');
	const one = document.getElementById('one')!;
	const two = document.getElementById('two')!;
	const fired = { one: 0, two: 0 };
	const warmed = { one: 0, two: 0 };
	const live = defer();
	arm_interaction(
		one,
		() => warmed.one++,
		() => {
			fired.one++;
			return live.promise;
		}
	);
	arm_interaction(
		two,
		() => warmed.two++,
		() => {
			fired.two++;
			return live.promise;
		}
	);

	const btn = two.querySelector('button')!;
	btn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
	btn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
	expect(warmed).toEqual({ one: 0, two: 1 }); // the pointer crossed into `two`, once

	btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
	btn.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
	expect(fired).toEqual({ one: 0, two: 1 }); // one wake, only for `two`

	// a click while waking is CANCELED (queued for the replay) — native activation never happens
	const click = new MouseEvent('click', { bubbles: true, cancelable: true });
	btn.dispatchEvent(click);
	expect(click.defaultPrevented).toBe(true);

	// an outside click is nobody's
	const outside = new MouseEvent('click', { bubbles: true, cancelable: true });
	document.body.dispatchEvent(outside);
	expect(outside.defaultPrevented).toBe(false);
	live.resolve();
});

test('a nested region that is not armed hands the event to the armed region above it', () => {
	document.body.innerHTML = region('outer', region('inner') + '<span>x</span>');
	const outer = document.getElementById('outer')!;
	const inner = document.getElementById('inner')!;
	let fired = 0;
	arm_interaction(
		outer,
		() => {},
		() => void fired++
	);
	inner.querySelector('button')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
	expect(fired).toBe(1);
});

test('disarm forgets the region: later events pass through untouched', () => {
	document.body.innerHTML = region('gone');
	const gone = document.getElementById('gone')!;
	let fired = 0;
	const disarm = arm_interaction(
		gone,
		() => {},
		() => void fired++
	);
	disarm();
	const click = new MouseEvent('click', { bubbles: true, cancelable: true });
	gone.querySelector('button')!.dispatchEvent(click);
	expect(fired).toBe(0);
	expect(click.defaultPrevented).toBe(false);
});

test('a SCHEDULED island is armed the same way: a click before it is live is canceled and queued', () => {
	document.body.innerHTML = `<ogygia-region id="sched" wake="visible" entry="/x.js"><button>tab 2</button></ogygia-region>`;
	const el = document.getElementById('sched')!;
	let fired = 0;
	const disarm = arm_interaction(
		el,
		() => {},
		() => {
			fired++;
			return new Promise<void>(() => {});
		}
	);
	const click = new MouseEvent('click', { bubbles: true, cancelable: true });
	el.querySelector('button')!.dispatchEvent(click);
	expect(fired).toBe(1);
	expect(click.defaultPrevented).toBe(true);
	disarm();
});

test('a live island inside a sleeping one keeps its clicks', () => {
	document.body.innerHTML = `<ogygia-region id="outer" wake="idle" entry="/o.js"><ogygia-region id="inner" wake="load" entry="/i.js" data-hydrated><button>live</button></ogygia-region></ogygia-region>`;
	const outer = document.getElementById('outer')!;
	let fired = 0;
	const disarm = arm_interaction(
		outer,
		() => {},
		() => {
			fired++;
		}
	);
	const click = new MouseEvent('click', { bubbles: true, cancelable: true });
	document.querySelector('#inner button')!.dispatchEvent(click);
	expect(fired).toBe(0);
	expect(click.defaultPrevented).toBe(false);
	disarm();
});

test('a click that opens a link elsewhere is never canceled (an untrusted replay could not open it)', () => {
	document.body.innerHTML = region('links', '<a href="/next">next</a>');
	const el = document.getElementById('links')!;
	const disarm = arm_interaction(
		el,
		() => {},
		() => new Promise<void>(() => {})
	);
	const a = el.querySelector('a')!;
	// read on the link itself — after the document's capture listener ran, before the test cancels the
	// navigation (a real one would leave the test page)
	let canceled_by_ogygia: boolean | null = null;
	a.addEventListener('click', (e) => {
		canceled_by_ogygia = e.defaultPrevented;
		e.preventDefault();
	});
	for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
		a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
		expect(canceled_by_ogygia, JSON.stringify(init)).toBe(false);
	}
	// a plain click is canceled and queued for the replay
	a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	expect(canceled_by_ogygia).toBe(true);
	disarm();
});
