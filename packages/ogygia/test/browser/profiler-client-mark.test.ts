// `mark()` from ogygia/profiler/client in a real browser: with the profiler's beacon tag present a
// mark (a function, a promise, an event, a handle) rides the same batched beacon as the islands;
// without the tag nothing is queued or sent.
import { expect, test } from 'vitest';
import { mark } from '../../src/profiler/client.js';
import { _reset_beacon, _beacon_state } from '../../src/runtime/beacon.js';

function with_tag(): { meta: HTMLMetaElement; sent: string[]; restore: () => void } {
	_reset_beacon();
	const meta = document.createElement('meta');
	meta.name = 'ogygia-profiler-beacon';
	meta.content = '/__profiler/beacon';
	document.head.appendChild(meta);
	const sent: string[] = [];
	const orig = navigator.sendBeacon;
	navigator.sendBeacon = ((_url: string, body: string) => {
		sent.push(body);
		return true;
	}) as typeof navigator.sendBeacon;
	return {
		meta,
		sent,
		restore() {
			navigator.sendBeacon = orig;
			meta.remove();
		}
	};
}

test('mark: a function, a promise, a failing one, an event and a handle — one batched beacon', async () => {
	const t = with_tag();
	try {
		expect(mark('sync', () => 42, { kind: 'sync' })).toBe(42);
		await expect(mark('async', new Promise((r) => setTimeout(() => r('ok'), 20)))).resolves.toBe('ok');
		await expect(mark('fails', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		const ready = mark.event('ready', 'widget-ready');
		document.dispatchEvent(new Event('widget-ready'));
		await ready;
		const h = mark.start('manual', { v: 1 });
		h.end({ rows: 3 });
		h.end(); // twice: a no-op
		mark.start('since-nav', undefined, { from: 'navigation' }).end();
		// (an idle browser may have flushed part of the queue already — read every body sent)
		dispatchEvent(new Event('pagehide'));
		const bodies = t.sent.map((b) => JSON.parse(b) as { page: string; marks?: { name: string; ms: number; attrs?: Record<string, unknown> }[] });
		const marks = bodies.flatMap((b) => b.marks ?? []);
		expect(bodies.every((b) => b.page === location.pathname)).toBe(true);
		expect(marks.map((m) => m.name)).toEqual(['sync', 'async', 'fails', 'ready', 'manual', 'since-nav']);
		expect(marks[0].attrs).toEqual({ kind: 'sync' });
		expect(marks[1].ms).toBeGreaterThanOrEqual(15);
		expect(marks[2].attrs).toEqual({ error: true });
		expect(marks[4].attrs).toEqual({ v: 1, rows: 3 });
		expect(marks[5].ms).toBeGreaterThan(marks[4].ms); // from the page's start, not the call
		expect(_beacon_state().marks).toBe(0);
	} finally {
		t.restore();
	}
});

test('mark without the beacon tag: runs the work, queues nothing', async () => {
	_reset_beacon();
	const sent: string[] = [];
	const orig = navigator.sendBeacon;
	navigator.sendBeacon = ((_u: string, b: string) => (sent.push(b), true)) as typeof navigator.sendBeacon;
	try {
		expect(mark('x', () => 'y')).toBe('y');
		expect(_beacon_state().marks).toBe(0);
		dispatchEvent(new Event('pagehide'));
		expect(sent).toEqual([]);
	} finally {
		navigator.sendBeacon = orig;
	}
});
