import { describe, it, expect } from 'vitest';
import { mark_personal } from '../src/server/personal-response.ts';

describe('mark_personal', () => {
	it('a page made for one browser leaves every shared cache, whatever the app set', () => {
		const res = new Response('x', {
			headers: { 'cache-control': 'public, s-maxage=600', vary: 'Accept-Encoding' }
		});
		mark_personal(res);
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		expect(res.headers.get('vary')).toBe('Accept-Encoding, Cookie');
	});
	it('an immutable response is left as it is', () => {
		const res = Response.redirect('http://app.test/', 302);
		expect(() => mark_personal(res)).not.toThrow();
	});
});
