import type { CompileCtxInit } from '../src/compiler/ctx.ts';

/** A suite that drives only the prescan / transform / resolve phases builds its `CompileCtx` from the
 *  fields those phases read, and leaves the rest of `CompileCtxInit` (mostly the virtual-module emit
 *  config: secret, rate limit, router flags, runtime paths) unset. Test-only exception: this cast is
 *  the one place such a partial init meets the full type. The fields a suite does pass are still
 *  checked, so a renamed or removed field fails here. */
export function partial_ctx_init(init: Partial<CompileCtxInit>): CompileCtxInit {
	return init as CompileCtxInit;
}
