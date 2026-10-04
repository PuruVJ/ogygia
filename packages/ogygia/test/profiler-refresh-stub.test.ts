// A prerendered route that redirects is written as a page: a meta refresh (and a script) answered
// 200. The profiler follows it as the redirect it is, to the page its visitors land on.
import { expect, test } from 'vitest';
import { refresh_target } from '../src/profiler/refresh-stub.js';

const origin = 'http://127.0.0.1:4192';

test('the build’s redirect stub: the path it sends the visitor to', () => {
	const kit = '<script>location.href="/docs/start/overview";</script><meta http-equiv="refresh" content="0;url=/docs/start/overview">';
	expect(refresh_target(kit, origin)).toBe('/docs/start/overview');
	// other spellings: the attribute order, a space, quotes, a query, the full URL of this origin
	expect(refresh_target(`<meta content="0; URL='/a?b=1'" http-equiv="refresh">`, origin)).toBe('/a?b=1');
	expect(refresh_target(`<META HTTP-EQUIV="refresh" CONTENT="0;url=${origin}/x">`, origin)).toBe('/x');
	expect(refresh_target('<meta http-equiv="refresh" content="0;url=docs">', origin + '/')).toBe('/docs');
});

test('not a stub: no refresh, another origin, no url, a real page', () => {
	expect(refresh_target('<p>hi</p>', origin)).toBeNull();
	expect(refresh_target('<meta http-equiv="refresh" content="0;url=https://elsewhere.test/">', origin)).toBeNull();
	// a refresh that only reloads the page
	expect(refresh_target('<meta http-equiv="refresh" content="30">', origin)).toBeNull();
	// a whole page with a refresh tag is a page
	expect(refresh_target(`<meta http-equiv="refresh" content="0;url=/x">${'<p>text</p>'.repeat(300)}`, origin)).toBeNull();
	expect(refresh_target('', origin)).toBeNull();
});
