import { handle as ogygiaHandle } from 'ogygia/server';

// ogygia's server handle: serves the signed island endpoint AND injects the SPA router (runtime +
// `ogygia-router` meta) so csr=false navigations are soft body-swaps, not full reloads.
export const handle = ogygiaHandle();
