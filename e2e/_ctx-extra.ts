/**
 * Compiler-context fields (`HostCtx` / `TsRegionCtx`) added after these compiler-unit harnesses were
 * first written. Spread `...CTX_EXTRA` at the TOP of each mock ctx literal (so any explicit override
 * a test sets — e.g. `linkVirtualIsland: false` — still wins) to satisfy the current context shapes.
 * Test-only defaults; a real build derives every one of these from Kit/plugin config.
 */
export const CTX_EXTRA = {
	importKeys: undefined,
	idSalt: '',
	linkVirtualIsland: true,
	clientBindingStub: '',
	routeCsr: undefined,
	ssr: false
};
