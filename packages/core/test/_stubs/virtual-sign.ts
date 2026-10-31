// Test stub for `virtual:ogygia/sign` (the plugin's HMAC module). Plugin packages' unit tests only need
// the server graph (`ogygia/internal/server`) to load; a suite that signs mocks it itself.
export const sign = (_secret: string, message: string): string => message;
export const verify = (_secret: string, message: string, sig: string): boolean => message === sig;
export const region_mac_message = (...parts: unknown[]): string =>
	parts.map((p) => String(p ?? '')).join('|');
