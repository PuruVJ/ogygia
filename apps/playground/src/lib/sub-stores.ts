// Fixture stores for the store-snippet e2e: module-level, deterministic on both server and
// client (same initial values), so the crossed SNAPSHOT and the hydrated DOM always agree.
import { writable } from 'svelte/store';

export const country = writable('fr');
export const language = writable('en');
