/** An island's hydration status: worked out in the browser (devtools/hydration.ts), read by the testing API. */
export type HydrationStatus = 'failed' | 'recovered' | 'healed' | 'changed' | 'asleep' | 'clean';
