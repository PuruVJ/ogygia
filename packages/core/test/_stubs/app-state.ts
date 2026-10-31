// Test stub for Kit's `$app/state` — the shell components read `page.url`/`page.params` at module
// scope; unit tests only need the graph to LOAD, never a live router. (Aliased in vitest.config.ts.)
export const page = {
	url: new URL('http://localhost/'),
	params: {} as Record<string, string>,
	route: { id: null as string | null },
	status: 200,
	error: null as Error | null,
	data: {} as Record<string, unknown>,
	state: {} as Record<string, unknown>,
	form: null as unknown
};
export const navigating = {
	from: null,
	to: null,
	type: null,
	willUnload: null,
	delta: null,
	complete: null
};
export const updated = { current: false, check: async () => false };
