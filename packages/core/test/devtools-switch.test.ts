// THE DEVTOOLS SWITCH (insights/switch.ts): in a build with devtools, one cookie decides whether this
// browser sees and measures devtools; `?og-devtools=on|off` flips it. A browser that clicked the old
// launcher (`og_devtools=1`) stays off.
import { describe, it, expect } from 'vitest';
import {
	switch_in_url,
	switch_on_in,
	without_switch,
	DEVTOOLS_PARAM
} from '../src/insights/switch.ts';

describe('the devtools switch', () => {
	it('reads on / off from the URL, nothing otherwise', () => {
		const at = (q: string) => switch_in_url(new URL('https://a.test/p' + q));
		expect(at('?og-devtools=on')).toBe(true);
		expect(at('?og-devtools=1')).toBe(true);
		expect(at('?og-devtools=off')).toBe(false);
		expect(at('?og-devtools=0')).toBe(false);
		expect(at('')).toBe(null);
		expect(at('?og-devtools=maybe')).toBe(null);
	});

	it('the address drops only the switch param', () => {
		const u = without_switch(new URL('https://a.test/p?x=1&og-devtools=on&y=2#h'));
		expect(u.href).toBe('https://a.test/p?x=1&y=2#h');
		expect(u.searchParams.has(DEVTOOLS_PARAM)).toBe(false);
	});

	it('is on only for the switch cookie, not the old launcher click', () => {
		expect(switch_on_in('a=1; og_devtools=on; b=2')).toBe(true);
		expect(switch_on_in('og_devtools=on')).toBe(true);
		expect(switch_on_in('og_devtools=1')).toBe(false);
		expect(switch_on_in('')).toBe(false);
		expect(switch_on_in('xog_devtools=on')).toBe(false);
	});
});
