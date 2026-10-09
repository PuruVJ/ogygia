/**
 * `background_start` is what makes `wake:'load'` mean "as soon as the browser is free" rather than
 * "synchronously at boot": a load island's hydrate (its import + Svelte runtime) is started at
 * background priority so the LCP paint and its image win the main thread and the network first. This
 * pins the contract — it NEVER runs the callback synchronously, prefers `scheduler.postTask` at
 * 'background', and falls back to a macrotask when postTask is unavailable or rejects the priority.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { background_start } from '../src/runtime/schedule.js';

type Sched = { postTask?: (cb: () => void, o?: { priority?: string }) => unknown };
const g = globalThis as { scheduler?: Sched };
const original = g.scheduler;

afterEach(() => {
	g.scheduler = original;
	vi.useRealTimers();
});

describe('background_start', () => {
	it('uses scheduler.postTask at background priority, never synchronously', () => {
		const postTask = vi.fn();
		g.scheduler = { postTask };
		const fn = vi.fn();
		background_start(fn);
		expect(fn).not.toHaveBeenCalled(); // not run inline
		expect(postTask).toHaveBeenCalledTimes(1);
		expect(postTask.mock.calls[0][1]).toEqual({ priority: 'background' });
		postTask.mock.calls[0][0](); // the background task runs
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('one background task starts everything queued before it runs (not a task per start)', () => {
		const postTask = vi.fn();
		g.scheduler = { postTask };
		const a = vi.fn();
		const b = vi.fn();
		const c = vi.fn();
		background_start(a);
		background_start(b);
		background_start(c);
		expect(postTask).toHaveBeenCalledTimes(1);
		postTask.mock.calls[0][0]();
		expect([a, b, c].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
		// drained: the next start posts a new task
		background_start(a);
		expect(postTask).toHaveBeenCalledTimes(2);
		postTask.mock.calls[1][0]();
	});

	it('falls back to a macrotask when scheduler.postTask is absent — async, not sync', () => {
		g.scheduler = undefined;
		vi.useFakeTimers();
		const fn = vi.fn();
		background_start(fn);
		expect(fn).not.toHaveBeenCalled(); // deferred, not synchronous
		vi.runAllTimers();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('falls back to a macrotask when postTask throws (older invalid-priority impl)', () => {
		g.scheduler = {
			postTask: () => {
				throw new Error('invalid priority');
			}
		};
		vi.useFakeTimers();
		const fn = vi.fn();
		expect(() => background_start(fn)).not.toThrow();
		expect(fn).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
