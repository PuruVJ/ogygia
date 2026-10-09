// THE WAKE GATE (runtime/schedule.ts `after_document_painted`): resolves after DOMContentLoaded and
// one painted frame, once per document, then stays resolved. The pre-DOMContentLoaded half is proven
// end to end (e2e/wake-gate.spec.ts holds a deferred script); here: a parsed document resolves in the
// task AFTER the next frame, never in the frame's own callbacks, and late callers pass straight through.
import { beforeEach, expect, test } from 'vitest';
import { after_document_painted, reset_document_painted } from '../../src/runtime/schedule.js';

beforeEach(() => reset_document_painted());

test('a parsed document: resolves after the next painted frame, not before it', async () => {
	let frame_ran = false;
	let resolved_in_frame = false;
	const gate = after_document_painted().then(() => {
		resolved_in_frame = !frame_ran;
	});
	requestAnimationFrame(() => {
		frame_ran = true;
	});
	await gate;
	expect(frame_ran).toBe(true);
	expect(resolved_in_frame).toBe(false);
});

test('once resolved, it is the same settled promise for every later wake', async () => {
	const first = after_document_painted();
	await first;
	expect(after_document_painted()).toBe(first);
	let late = false;
	void after_document_painted().then(() => (late = true));
	await Promise.resolve();
	expect(late).toBe(true); // a microtask, no frame wait
});
