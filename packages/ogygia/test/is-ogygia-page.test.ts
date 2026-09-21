/**
 * `isOgygiaPage()` — the public "which world am I in" check for shared code (a common store, a helper)
 * that must behave on BOTH a csr=false ogygia page and a csr=true Kit page. It is the inverse of the
 * internal `documentIsCsrTrue`, so it answers on both legs with no requestEvent handling on the caller:
 * server reads the request's route id against the build-time csr=true set, client reads Kit's bootstrap.
 * This exercises the server leg (BROWSER is false in a node test), mirroring kit-island-stamp's setup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { set_request_event_stub } from './_stubs/virtual-request-event.js';
import { csr_true_routes } from './_stubs/virtual-route-csr.js';
import { isOgygiaPage } from '../src/context.js';

/** Simulate one request on a route, its leaf page csr=true or not, and read `isOgygiaPage()`. */
function on_route(route_id: string, csr_true: boolean): boolean {
	set_request_event_stub(() => ({ route: { id: route_id } }));
	if (csr_true) csr_true_routes.add(route_id);
	try {
		return isOgygiaPage();
	} finally {
		csr_true_routes.delete(route_id);
	}
}

afterEach(() => set_request_event_stub(null));

describe('isOgygiaPage — server leg', () => {
	it('is true on a csr=false route (an ogygia page)', () => {
		expect(on_route('/about', false)).toBe(true);
	});

	it('is false on a csr=true route (Kit hydrates the whole document)', () => {
		expect(on_route('/dashboard', true)).toBe(false);
	});

	it('is the exact inverse of the csr fact for the same route', () => {
		// one route, flipped: the two answers must never agree
		expect(on_route('/feed', false)).toBe(true);
		expect(on_route('/feed', true)).toBe(false);
	});

	it('off-request (no page — getRequestEvent throws) is a safe false-csr → true', () => {
		set_request_event_stub(null); // the reader throws, as it does outside a request
		expect(isOgygiaPage()).toBe(true);
	});
});
