// INLINE REGION CSS in a hole answer, in a real browser: the answer carries
// `<style data-ogygia-region-css="href">` (the sheet was under Kit's inlineStyleThreshold at build);
// the runtime hoists it into <head> before the swap, once per identity — against inline styles AND
// links the page already has for that href — so two holes sharing a sheet, or a page that already
// linked it, never stack copies.
import { expect, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';

const A = '/__ogygia__?id=abcabcabc001&props=W3t9XQ&exp=9999999999&sig=stub';
const B = '/__ogygia__?id=abcabcabc002&props=W3t9XQ&exp=9999999999&sig=stub';
const SHEET = '/_app/immutable/assets/Shared.abc.css';
const STYLE = `<style data-ogygia-region-css="${SHEET}">.shared-inline{letter-spacing:4px}</style>`;

function html_response(html: string, endpoint: string): Response {
	const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
	Object.defineProperty(res, 'url', { value: location.origin + endpoint });
	return res;
}

test('an inlined sheet in a hole answer is hoisted into <head> once, and styles the swapped HTML', async () => {
	document.head.querySelectorAll('[data-ogygia-region-css]').forEach((n) => n.remove());
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		const u = String(input);
		return html_response(`${STYLE}<p class="shared-inline" data-served="${u.includes('001') ? 'a' : 'b'}">served</p>`, u.includes('001') ? A : B);
	};
	document.body.innerHTML =
		`<ogygia-region render="defer" when="load" endpoint="${A}"><p data-fallback>a</p></ogygia-region>` +
		`<ogygia-region render="defer" when="load" endpoint="${B}"><p data-fallback>b</p></ogygia-region>`;
	try {
		bootDev();
		await expect.poll(() => document.querySelectorAll('[data-served]').length, { timeout: 10_000 }).toBe(2);
		const styles = document.head.querySelectorAll(`style[data-ogygia-region-css="${SHEET}"]`);
		expect(styles.length, 'one hoisted copy for two answers sharing the sheet').toBe(1);
		expect(document.body.querySelector('style[data-ogygia-region-css]'), 'no style left in the body').toBeNull();
		const served = document.querySelector('[data-served="a"]') as HTMLElement;
		expect(getComputedStyle(served).letterSpacing).toBe('4px');
	} finally {
		window.fetch = real_fetch;
	}
});

test('a sheet the page already LINKS is not inlined again from an answer', async () => {
	document.head.querySelectorAll('[data-ogygia-region-css]').forEach((n) => n.remove());
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = SHEET;
	link.setAttribute('data-ogygia-region-css', '');
	document.head.appendChild(link);
	const C = '/__ogygia__?id=abcabcabc003&props=W3t9XQ&exp=9999999999&sig=stub';
	const real_fetch = window.fetch;
	window.fetch = async () => html_response(`${STYLE}<p data-served="c">served</p>`, C);
	document.body.innerHTML = `<ogygia-region render="defer" when="load" endpoint="${C}"><p data-fallback>c</p></ogygia-region>`;
	try {
		bootDev();
		await expect.poll(() => document.querySelectorAll('[data-served]').length, { timeout: 10_000 }).toBe(1);
		expect(document.head.querySelectorAll(`style[data-ogygia-region-css="${SHEET}"]`).length).toBe(0);
	} finally {
		window.fetch = real_fetch;
		link.remove();
	}
});
