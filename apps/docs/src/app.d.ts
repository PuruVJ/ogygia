declare global {
	namespace App {
		interface PageData {
			/** This deployment's origin, for absolute OG image URLs (see +layout.server.ts). */
			ogOrigin?: string;
		}
	}
}

// Font assets imported for the OG endpoint; Vite resolves them to a URL that `read()` consumes.
declare module '*.woff' {
	const url: string;
	export default url;
}

export {};
