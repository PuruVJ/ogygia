import { cms } from '#lib/cms.js';

// The mount: the 404/redirect guard comes off the site mint. No `entries` — nothing prerenders.
export const load = cms.load;
