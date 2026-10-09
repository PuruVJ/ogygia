// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	interface Window {
		/** Per-page `$app/state` snapshot the ogygia shims seed from. */
		__ogygiaPage?: unknown;
	}
}

export {};
