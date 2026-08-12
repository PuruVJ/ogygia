// Test stub for Kit's `$app/server` — mirrors the callable + `__.type` shape the content factory
// relies on, without a running Kit app. (Aliased in vitest.config.ts.)
function remote(type: string, fn: (...a: unknown[]) => unknown) {
	return Object.assign((...args: unknown[]) => fn(...args), { __: { type } });
}
export function prerender(a: unknown, b?: unknown) {
	const run = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown;
	return remote('prerender', run);
}
type QueryFn = ((a: unknown, b?: unknown) => unknown) & {
	live: (a: unknown, b?: unknown) => unknown;
	batch: (fn: unknown) => unknown;
};
export const query = ((a: unknown, b?: unknown) => {
	const run = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown;
	return remote('query', run);
}) as QueryFn;
query.live = (a: unknown, b?: unknown) => {
	const gen = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown;
	return remote('query_live', gen);
};
query.batch = (fn: unknown) => fn;
