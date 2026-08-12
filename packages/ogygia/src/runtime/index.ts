/**
 * Browser sticky runtime entry (`import 'ogygia/runtime'`). Importing this boots the kitchen-sink
 * runtime ({@link ./full.js}) as a side effect. A per-app build instead points the entry at a
 * generated module (see `vite/runtime-entry.ts`) that boots only the features it uses.
 */
import './full.js';
