/// <reference types="ogygia/ambient" />

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
		/** Set once per full page load by the ogygia runtime; survives SPA navigations. */
		__marker?: number;
		/** Bumped by the bundled `<script island>` helper (scripts demo). */
		__bundledHelperMarked?: number;
		/** Per-page `$app/state` snapshot the ogygia shims seed from. */
		__ogygiaPage?: unknown;
	}
}

export {};
