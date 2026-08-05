// Ambient types for ogygia's build-time virtual modules. The library ships `.svelte` components
// (ClientRouter, Island, ServerIsland) that import these; the ogygia vite plugin provides them at
// build time, but a consumer's `svelte-check` needs the declarations to type-check the imports.
declare module 'virtual:ogygia/runtime-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/secret' {
	export const secret: string;
}
