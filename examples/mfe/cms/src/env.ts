import { defineEnvVars } from '@sveltejs/kit/env';

// Kit 3 exposes only the variables declared here (via `$app/env/private`). All optional: the keys
// come from `source keys.env` (see ../README.md), the origins default to the local ports.
const optional = { schema: (value: string | undefined) => value };

export const variables = defineEnvVars({
	CMS_SIGNING_KEY: optional,
	DASH_ORIGIN: optional,
	DASH_PUBLIC_KEY: optional,
	SHELL_ORIGIN: optional,
	SHELL_PUBLIC_KEY: optional
});
