// The playground's client hooks. They exist so every e2e run exercises the runtime's `hooks.client`
// path: the runtime entry then dynamic-imports this module (and its chunk name gains an `h` —
// compiler/ctx.ts `runtime_chunk_filename`). REGRESSION: that `h` once stopped the build from
// recognising the runtime chunk, and apps with client hooks shipped the runtime with no preloads.
// `init` runs once when the runtime boots; e2e/lazy-chunks.spec.ts reads the flag.
export function init(): void {
	(globalThis as Record<string, unknown>).__og_client_init = true;
}
