import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// since env.js is an entrypoint, `dir` will point to the output directory
const dir = path.dirname(fileURLToPath(import.meta.url));

const expected_unprefixed = new Set(['LISTEN_PID', 'LISTEN_FDS']);

const env_prefix = "";

/**
 * @param {string} name
 * @param {any} [fallback]
 */
function env(name, fallback) {
	const prefix = expected_unprefixed.has(name) ? '' : env_prefix;
	const prefixed = prefix + name;
	return prefixed in process.env ? process.env[prefixed] : fallback;
}

const integer_regexp = /^\d+$/;

/**
 * Throw a consistently-structured parsing error for environment variables.
 * @param {string} name
 * @param {any} value
 * @param {string} description
 * @returns {never}
 */
function parsing_error(name, value, description) {
	throw new Error(
		`Invalid value for environment variable ${name}: ${JSON.stringify(value)} (${description})`
	);
}

/**
 * Check the environment for a timeout value (non-negative integer) in seconds.
 * @param {string} name
 * @param {number} [fallback]
 * @returns {number | undefined}
 */
function timeout_env(name, fallback) {
	const raw = env(name, fallback);
	if (!raw) {
		return fallback;
	}

	if (!integer_regexp.test(raw)) {
		parsing_error(name, raw, 'should be a non-negative integer');
	}

	const parsed = Number.parseInt(raw, 10);

	// We don't technically need to check `Number.isNaN` because the value already passed the regexp test.
	// However, just in case there's some new codepath introduced somewhere down the line, it's probably good
	// to stick this in here.
	if (Number.isNaN(parsed)) {
		parsing_error(name, raw, 'should be a non-negative integer');
	}

	if (parsed < 0) {
		parsing_error(name, raw, 'should be a non-negative integer');
	}

	return parsed;
}

export { dir, env, env_prefix, timeout_env };
//# sourceMappingURL=env.js.map
