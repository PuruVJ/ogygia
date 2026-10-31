// `hydratedBy()` says `'interaction'` whenever a visitor's input woke the island — an `interaction`
// island, and a scheduled one pressed before its schedule made it live (its first click is a replay).
import { expect, test } from 'vitest';
import { hydratedBy } from '../../src/hydration-info.ts';
import { arm_interaction } from '../../src/runtime/interaction.ts';

const CURRENT_REGION = Symbol.for('ogygia.context.current-region');
const as_current = (el: Element | null) =>
	((globalThis as Record<symbol, unknown>)[CURRENT_REGION] = el);

test('a scheduled island its schedule woke reports its schedule', () => {
	document.body.innerHTML =
		'<ogygia-region id="r" wake="visible" entry="/x.js"><button>b</button></ogygia-region>';
	as_current(document.getElementById('r'));
	expect(hydratedBy()).toBe('visible');
	as_current(null);
});

test('a scheduled island a visitor pressed first reports interaction', () => {
	document.body.innerHTML =
		'<ogygia-region id="r" wake="visible" entry="/x.js"><button>b</button></ogygia-region>';
	const el = document.getElementById('r')!;
	const disarm = arm_interaction(
		el,
		() => {},
		() => new Promise<void>(() => {})
	);
	el.querySelector('button')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
	as_current(el);
	expect(hydratedBy()).toBe('interaction');
	as_current(null);
	disarm();
});
