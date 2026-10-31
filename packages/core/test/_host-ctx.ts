// Shared by the region-transform suites that build a host-compile context by hand.

/** The host-compile fields a suite does not exercise, at exactly the values the transform falls back
 *  to when they are missing: `importKeys` → the default keys, `idSalt || ''`, `linkVirtualIsland
 *  !== false`, an empty `clientBindingStub` → the built-in stub, no route `csr`, the client leg. A
 *  suite spreads this first and overrides what it tests. */
export const HOST_CTX_DEFAULTS: {
	importKeys: undefined;
	idSalt: string;
	linkVirtualIsland: boolean;
	clientBindingStub: string;
	routeCsr: boolean | undefined;
	ssr: boolean;
} = {
	importKeys: undefined,
	idSalt: '',
	linkVirtualIsland: true,
	clientBindingStub: '',
	routeCsr: undefined,
	ssr: false
};
