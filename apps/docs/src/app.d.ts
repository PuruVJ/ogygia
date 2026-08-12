declare global {
	namespace App {}
}

// Font assets imported for the OG endpoint; Vite resolves them to a URL that `read()` consumes.
declare module '*.woff' {
	const url: string;
	export default url;
}

export {};
