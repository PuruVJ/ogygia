// LATECOMER's helper: the feature flags, read from disk. Fast (a small file the OS has cached), so
// no CPU sample lands on it — the profiler finds it by V8's call counts and this file's code.
import { readFileSync } from 'node:fs';

/** PATTERN sync-io: the flags file read from disk on every request, blocking the server */
export function readFlags(): number {
	return readFileSync('package.json', 'utf8').length;
}
