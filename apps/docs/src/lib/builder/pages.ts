/**
 * A content collection whose SOURCE is Builder.io — here, local fixtures in Builder's JSON shape
 * (swap the glob for a loader that hits Builder's Content API and nothing else changes). Each entry's
 * `body` is the rendered block tree; look one up with `builderPages.get(slug)`.
 */
import { content } from 'ogygia/content';
import type { ContentHandle } from 'ogygia/content';
import { builderSource } from './from-builder';
import { registry } from './registry';

// `builderSource` maps Builder's JSON to a block tree and renders it; `glob` derives `home`/`pricing`
// slugs from the filenames.
export const builderPages: ContentHandle = content({
	loader: builderSource(import.meta.glob('./pages/*.json', { eager: true }), registry)
});
