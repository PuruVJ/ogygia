// Test stub for `virtual:ogygia/kit-wire` (real one re-exports Kit's internal remote-key helper,
// resolved by the Vite plugin). Mirrors Kit's `id/payload` join shape closely enough for units.
export function create_remote_key(id: string, payload: string): string {
	return `${id}/${payload}`;
}
