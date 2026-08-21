/**
 * The BROWSER compiler surface (the Observatory, internal/notes/devtools.md Rung 1). A minimal entry
 * that re-exports ONLY what a browser build needs to run the real host transform — deliberately NOT
 * the compiler barrel (`./index.js`), which pulls the node-heavy driver / Program / CompileCtx (and
 * their `node:fs` / kit graph). These low-level modules only reach for `node:crypto` / `node:fs` /
 * `node:path`, which a browser build shims (see the Observatory's node-shims plugin).
 */
export { transformHost, wrapperVirtualId, CLIENT_BINDING_STUB } from './region/transform.js';
export { islandVirtualId } from './ids.js';
export { set_parser, type RawParse, type ParseResult } from './parse/oxc.js';
