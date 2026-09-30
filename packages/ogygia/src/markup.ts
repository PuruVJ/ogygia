/**
 * `ogygia/markup` — working with the HTML ogygia renders, outside ogygia's own pipeline. Kit-free and
 * import-free, so it runs anywhere: the non-SvelteKit half of a monorepo, a vitest corpus in jsdom.
 *
 * - `scanRegions` / `liftRegions` / `restoreRegions`: find every region in a document, or lift them
 *   out around a foreign SSR pass and splice them back.
 * - `transformMarkup`: the server round trip of `ogygia.handle({ transform })` — mark, the transform,
 *   settle — for a test that runs an app's transform over harvested markup; `checkScript(settled.check)`
 *   is the dev check's payload to put in front of it (with `{ dev: true }`), so `restore` checks each host.
 * - `localizeMarks`: stable mark ids for a transform that caches its renders by markup.
 * - `restore`: the browser half, on a parsed document or fragment — what the handle inlines in every
 *   page of an app with a transform.
 */
export {
	scanRegions,
	liftRegions,
	restoreRegions,
	type RegionKind,
	type RegionSpan,
	type LiftedRegion,
	type LiftResult
} from './server/split-regions.js';
export {
	transformMarkup,
	localizeMarks,
	check_script as checkScript,
	type Settled,
	type TransformKind
} from './server/reversible.js';
export { restore } from './runtime/restore.js';
