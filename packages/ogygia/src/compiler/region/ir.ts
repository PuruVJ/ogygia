/**
 * The IR — the seam between the region front-end's phases. `analyze` reads a file's AST into a
 * `FileIR` (what the file declares: its imports, region marks, asRegion call sites, usage findings,
 * csr tri-state); `lower` consumes the `FileIR` and rewrites the source, minting `IslandDescriptor`s.
 * `FileIR` is the ONLY thing that crosses analyze → lower — pure data, no closures — which is what
 * lets the two phases live in separate modules.
 *
 * The Svelte AST is manipulated dynamically throughout the front-end (as it was when the pass was
 * fused), so the node-bearing fields stay loosely typed via `SvelteNode` — the same shape the fused
 * `transformHost` always used.
 */
import type { ImportKeys } from './transform.js';

/** A Svelte / ESTree node as the front-end walks it — dynamic access, loosely typed by design. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SvelteNode = any;

/** A region mark — the `{ strategy, options }` a `with { … }` clause or `asRegion(…)` resolves to. */
export interface RegionMark {
	strategy: string;
	options: Record<string, unknown>;
}

/** One host import the analyze pass indexed: its ImportDeclaration node + the `with {…}`-stripped text. */
export interface HostImport {
	node: SvelteNode;
	cleaned: string;
}

/**
 * `FileIR` — analyze's output, lower's input. Everything the lowering pass reads about one file,
 * bundled as plain data. Cross-file knowledge never enters here: a file's IR knows only its own
 * source, never what another file did (the join is by content-hashed region id, in the Program).
 */
export interface FileIR {
	source: string;
	id: string;
	/** the parsed Svelte AST (root `.fragment` / `.instance` / `.module`). */
	ast: SvelteNode;
	/** `<script>` (instance) top-level statements. */
	instance_body: SvelteNode[];
	/** `<script module>` top-level statements. */
	module_body: SvelteNode[];
	/** the `<script>` lang attribute (`''` for plain JS) — baked into generated wrapper scripts. */
	lang: string;
	/** posix root-relative host path — the stable prefix of error messages + snippet identities. */
	rel_host: string;
	/** the resolved import-attribute key names for this build. */
	import_keys: ImportKeys;
	/** localName → { node, cleaned } for every host import. */
	imports: Map<string, HostImport>;
	/** localName → the region mark it carries (a `with {…}` import or an asRegion synthetic import). */
	marked_components: Map<string, RegionMark>;
	/** ImportDeclaration nodes to remove from the host (unused marked imports / consumed barrels). */
	imports_to_strip: Set<{ start: number; end: number }>;
	/** the asRegion call sites — the local binding, the component local, and the const statement node. */
	as_regions: Array<{ local: string; compLocal: string; node: { start: number; end: number } }>;
	/** the asRegion `const` statement nodes (skipped by the stray-asRegion walk + barrel-cleanup). */
	as_region_nodes: Set<SvelteNode>;
	/** asRegion local → the barrel export name it pulls (undefined → default import). */
	synthetic_export: Map<string, string | undefined>;
	/** a hydrate island with real host children was placed (the app needs the wire slot revivers). */
	has_island_children: boolean;
	/** the cheap island-hint gate result (a marker-less snippet-only file is not "hinted"). */
	has_island_hint: boolean;
}
