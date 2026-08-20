import * as ogygia from 'ogygia';
import { SharedCounter } from './counter-object.svelte.js';

/**
 * Cross-island context matrix. `roomCtx` carries a live transportable (`SharedCounter`) shared
 * across islands; `themeCtx` carries a plain string (snapshot) and has a default; `orphanCtx` is
 * never provided anywhere, so every consumer must fall back to its default.
 */
export const roomCtx = ogygia.createContext<SharedCounter>('room');
export const themeCtx = ogygia.createContext<string>('theme', 'light');
export const orphanCtx = ogygia.createContext<string>('orphan', 'orphan-default');
