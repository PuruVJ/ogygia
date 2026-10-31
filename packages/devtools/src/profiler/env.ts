/**
 * Is this a dev server? Vite replaces `import.meta.env.DEV` at build time; a plain-Node run falls
 * back to NODE_ENV. Its own module so a test can mock the answer (the value is otherwise a
 * compile-time constant inside the profiler) and exercise the production request path.
 */
export function detect_dev(): boolean {
	return (
		(typeof import.meta !== 'undefined' &&
			(import.meta as { env?: { DEV?: boolean } }).env?.DEV === true) ||
		process.env.NODE_ENV === 'development'
	);
}
