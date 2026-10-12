/**
 * The app's universal `transport` DECODERS, for the client page seed + streamed resolves — so a load's
 * CUSTOM types (a class the app teaches Kit via `hooks.transport`) round-trip into islands, not just
 * built-in devalue types. Isolated in its own module so the low-level `page-defer.ts` (imported by unit
 * tests WITHOUT the vite plugin) never pulls `virtual:ogygia/transport`; `core.ts` imports this and
 * injects the decoders. Universal hooks are isomorphic, so this is client-safe. Built once, in the
 * virtual (compiler/link/transport.ts), with every other reader of the app codec.
 */
import { decoders } from 'virtual:ogygia/transport';

/** `{ [typeName]: decode }` from the app's `hooks.transport`; empty when the app defines none. */
export const transport_decoders = decoders as Record<string, (payload: never) => unknown>;
