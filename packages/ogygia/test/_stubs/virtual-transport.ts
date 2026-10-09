// `virtual:ogygia/transport` stub: the app's universal `hooks.transport` codecs. Tests boot the runtime
// without the Vite plugin, so there is no app and no custom types — an empty map is the truthful value.
export const transport: Record<
	string,
	{ encode: (v: unknown) => unknown; decode: (v: never) => unknown }
> = {};
