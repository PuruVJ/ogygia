import { site } from '$lib/cms';

// The client search index, served DYNAMICALLY (the corpus is remote — nothing prerenders). Block
// entries carry no raw source, so they index as display fields (title + summary).
export const GET = site.emit.search();
