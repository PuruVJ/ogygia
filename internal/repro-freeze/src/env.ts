import { defineEnvVars } from '@sveltejs/kit/env';

// Kit 3 only exposes declared variables. The edge emulators' base URLs (set by e2e/freeze.ts) are
// optional: unset → origin store only.
const optional = (value: string | undefined) => value || undefined;

export const variables = defineEnvVars({
	EDGE_AKAMAI_URL: { schema: optional },
	EDGE_CF_URL: { schema: optional },
	EDGE_SITE_URL: { schema: optional }
});
