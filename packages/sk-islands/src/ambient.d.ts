// Ambient type augmentation for sk-islands authoring syntax. Reference it from your app's
// `src/app.d.ts`:
//
//   /// <reference types="sk-islands/ambient" />
//
// It teaches svelte-check about the bundled `<script bundle>` attribute (a nested <script>
// that sk-islands extracts into its own module chunk).
import 'svelte/elements';

declare module 'svelte/elements' {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	interface HTMLAttributes<T extends EventTarget> {
		/**
		 * sk-islands: mark a nested `<script>` to be extracted into its own bundled module
		 * chunk (imports resolve + bundle; the URL is de-duped across SPA navigations).
		 */
		bundle?: boolean | string;
	}
}

export {};
