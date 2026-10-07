// THE LOAD SCHEDULER (runtime/load-scheduler.ts): every download ogygia starts on its own asks for a
// slot. Island code and background work wait for the painted document and the page's critical
// resources (`fetchpriority="high"`), or the visitor's first input, or a cap; background classes share
// a small window, `ahead` before `speculative`; a gesture never waits; visible content never waits.
//
// REGRESSION (a field report, 2026-10-07): on country home pages the hero image (the LCP, marked
// fetchpriority="high") shared its bandwidth with 206 island requests once the wake gate opened —
// 1.19 s → 2.27 s, LCP about 1 s worse.
import { expect, test, beforeEach, afterEach } from 'vitest';
import {
	BACKGROUND_WINDOW,
	critical_outcome,
	critical_settled,
	fetch_priority_of,
	load_slot,
	reset_load_scheduler,
	viewport_class
} from '../../src/runtime/load-scheduler.js';
import { reset_document_painted } from '../../src/runtime/schedule.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A critical image that has not arrived: `complete` false until the test fires its load. */
function pending_hero(): HTMLImageElement {
	const img = document.createElement('img');
	img.setAttribute('fetchpriority', 'high');
	Object.defineProperty(img, 'complete', { configurable: true, get: () => false });
	document.body.appendChild(img);
	return img;
}

beforeEach(() => {
	reset_load_scheduler();
	reset_document_painted();
});
afterEach(() => {
	document.body.innerHTML = '';
});

test('priorities and the viewport class', () => {
	expect(fetch_priority_of('user')).toBe('high');
	expect(fetch_priority_of('visible')).toBe('auto');
	expect(fetch_priority_of('ahead')).toBe('low');
	expect(fetch_priority_of('speculative')).toBe('low');
	const on = document.createElement('div');
	on.style.cssText = 'width:10px;height:10px';
	const off = document.createElement('div');
	off.style.cssText = `position:absolute;top:${innerHeight + 500}px;width:10px;height:10px`;
	document.body.append(on, off);
	expect(viewport_class(on)).toBe('visible');
	expect(viewport_class(off)).toBe('ahead');
});

test('island code waits for the critical image; a gesture and visible content do not', async () => {
	const hero = pending_hero();
	const started: string[] = [];
	const ask = (label: string, kind: 'code' | 'content', cls: 'user' | 'visible' | 'ahead') =>
		load_slot({ kind, cls, label }).ready.then((release) => {
			started.push(label);
			release();
		});
	void ask('visible code', 'code', 'visible');
	void ask('ahead code', 'code', 'ahead');
	void ask('user code', 'code', 'user');
	void ask('visible html', 'content', 'visible');
	await tick(50); // past the painted frame
	expect(started.sort()).toEqual(['user code', 'visible html']);
	hero.dispatchEvent(new Event('load'));
	await tick();
	expect(started.sort()).toEqual(['ahead code', 'user code', 'visible code', 'visible html']);
	expect(critical_outcome()?.outcome).toBe('arrived');
});

test('the visitor’s first input releases the wait (the browser stops measuring LCP there)', async () => {
	pending_hero();
	let started = false;
	void load_slot({ kind: 'code', cls: 'visible' }).ready.then(() => (started = true));
	await tick(50);
	expect(started).toBe(false);
	document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
	await tick();
	expect(started).toBe(true);
	expect(critical_outcome()?.outcome).toBe('input');
});

test('no marked resource: code starts right after the paint', async () => {
	await critical_settled();
	expect(critical_outcome()).toEqual({
		outcome: 'none',
		resources: 0,
		waited_ms: expect.any(Number)
	});
	let started = false;
	void load_slot({ kind: 'code', cls: 'visible' }).ready.then(() => (started = true));
	await tick();
	expect(started).toBe(true);
});

test('background work shares a window; ahead goes before speculative; release lets the next in', async () => {
	await critical_settled();
	const started: string[] = [];
	const releases: (() => void)[] = [];
	const ask = (label: string, cls: 'ahead' | 'speculative') =>
		void load_slot({ kind: 'content', cls, label }).ready.then((release) => {
			started.push(label);
			releases.push(release);
		});
	ask('s1', 'speculative');
	ask('s2', 'speculative');
	ask('s3', 'speculative');
	await tick();
	expect(started).toEqual(['s1', 's2', 's3'].slice(0, BACKGROUND_WINDOW));
	ask('s4', 'speculative');
	ask('a1', 'ahead');
	await tick();
	expect(started.length).toBe(BACKGROUND_WINDOW);
	releases[0]();
	await tick();
	expect(started.at(-1)).toBe('a1'); // ahead outranks a speculative that queued first
	releases[1]();
	await tick();
	expect(started.at(-1)).toBe('s4');
});

test('a queued download follows the viewport, and promote() lifts it', async () => {
	await critical_settled();
	const hold: (() => void)[] = [];
	for (let i = 0; i < BACKGROUND_WINDOW; i++)
		void load_slot({ kind: 'content', cls: 'ahead' }).ready.then((r) => hold.push(r));
	await tick();
	let cls: 'ahead' | 'visible' = 'ahead';
	let started = false;
	void load_slot({ kind: 'code', cls: () => cls }).ready.then(() => (started = true));
	await tick();
	expect(started).toBe(false); // ahead: the window is full
	cls = 'visible';
	dispatchEvent(new Event('scroll'));
	await tick(40);
	expect(started).toBe(true); // scrolled into view: visible code is not windowed

	let promoted = false;
	const queued = load_slot({ kind: 'content', cls: 'speculative' });
	void queued.ready.then(() => (promoted = true));
	await tick();
	expect(promoted).toBe(false);
	queued.ticket.promote('user');
	await tick();
	expect(promoted).toBe(true);
	for (const r of hold) r();
});
