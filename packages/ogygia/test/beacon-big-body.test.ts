// A page with ~300 islands posts a visit over 64 KB. sendBeacon and a keepalive fetch both refuse
// that, and the fetch's rejection went unhandled ("Failed to fetch" as a page error) while the
// profiler never got the page's browser side. The send now goes by size and by whether the page is
// still there.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const g = globalThis as Record<string, unknown>;
let beacons: number[];
let fetches: { n: number; keepalive: boolean }[];
let visibility: string;

beforeEach(() => {
	beacons = [];
	fetches = [];
	visibility = 'visible';
	g.document = {
		querySelector: (s: string) => (s.includes('ogygia-profiler-beacon') ? { getAttribute: () => '/__profiler/beacon' } : null),
		querySelectorAll: () => [],
		addEventListener: () => {},
		get visibilityState() {
			return visibility;
		},
		cookie: ''
	};
	g.addEventListener = () => {};
	// the browser's limits: both refuse a body over 64 KB
	vi.stubGlobal('navigator', {
		sendBeacon: (_u: string, body: string) => {
			if (body.length > 65536) return false;
			beacons.push(body.length);
			return true;
		}
	});
	vi.stubGlobal('fetch', (_u: string, init: { body: string; keepalive?: boolean }) => {
		fetches.push({ n: init.body.length, keepalive: !!init.keepalive });
		return init.keepalive && init.body.length > 65536 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response(null, { status: 204 }));
	});
});
afterEach(() => {
	delete g.document;
	delete g.addEventListener;
	vi.unstubAllGlobals();
});

test('a small body goes by sendBeacon, as before', async () => {
	const b = await import('../src/runtime/beacon.ts');
	b._reset_beacon();
	b._beacon_send('x'.repeat(1000));
	expect(beacons).toEqual([1000]);
	expect(fetches).toEqual([]);
});

test('a big body while the page is open goes by an ordinary request, which has no size limit', async () => {
	const b = await import('../src/runtime/beacon.ts');
	b._reset_beacon();
	b._beacon_send('x'.repeat(100_000), () => 'slim');
	expect(beacons).toEqual([]);
	expect(fetches).toEqual([{ n: 100_000, keepalive: false }]);
});

test('a big body as the page goes away sends the slim copy; nothing that cannot fit is tried', async () => {
	const b = await import('../src/runtime/beacon.ts');
	b._reset_beacon();
	visibility = 'hidden';
	b._beacon_send('x'.repeat(100_000), () => 'y'.repeat(12_000));
	expect(beacons).toEqual([12_000]);
	b._beacon_send('x'.repeat(100_000), () => 'y'.repeat(90_000));
	b._beacon_send('x'.repeat(100_000));
	expect(beacons).toEqual([12_000]);
	expect(fetches).toEqual([]);
});

test('the 64 KB is shared by everything queued at once: a hide that sends several fits them or slims them', async () => {
	const b = await import('../src/runtime/beacon.ts');
	b._reset_beacon();
	visibility = 'hidden';
	// the visit (40 KB) takes most of the room; a 30 KB message after it does not fit what is left —
	// its slim copy does; one with no slim copy is not tried (Safari refuses it: "maximum amount of
	// queued data")
	b._beacon_send('v'.repeat(40_000));
	b._beacon_send('i'.repeat(30_000), () => 'j'.repeat(8_000));
	b._beacon_send('c'.repeat(30_000));
	expect(beacons).toEqual([40_000, 8_000]);
	expect(fetches).toEqual([]);
	// a beacon says nothing back: its bytes count for the task that sent it (the hide's burst), then
	// the room is there again — the early visit, sent a moment before the hide, never crowds it
	vi.useFakeTimers();
	try {
		b._reset_beacon();
		b._beacon_send('v'.repeat(50_000));
		b._beacon_send('w'.repeat(20_000));
		expect(beacons.slice(2)).toEqual([50_000]);
		vi.advanceTimersByTime(1);
		b._beacon_send('w'.repeat(20_000));
		expect(beacons.slice(2)).toEqual([50_000, 20_000]);
	} finally {
		vi.useRealTimers();
	}
});

test('a refused request never becomes a page error', async () => {
	const b = await import('../src/runtime/beacon.ts');
	b._reset_beacon();
	const unhandled = vi.fn();
	process.on('unhandledRejection', unhandled);
	// sendBeacon missing: the keepalive fetch is the path, and it is refused
	vi.stubGlobal('navigator', {});
	vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
	b._beacon_send('x'.repeat(1000));
	await new Promise((ok) => setTimeout(ok, 10));
	process.off('unhandledRejection', unhandled);
	expect(unhandled).not.toHaveBeenCalled();
});
