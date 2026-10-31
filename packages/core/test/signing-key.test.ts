// THE SIGNING KEY (server/signing-key.ts): decided at first use, not at module eval — the field host
// (an adapter loading its `.env` after the server's modules) signed with the build's random key while
// the build itself had OGYGIA_SECRET, and the pages' holes 403'd on the other backend behind the same
// CDN. Its fingerprint rides every capability (`&k=`) so a refusal can name the split.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const build = vi.hoisted(() => ({ buildKey: 'build-random-key', buildHadSecret: false }));
vi.mock('virtual:ogygia/secret', () => build);
vi.mock('virtual:ogygia/sign', () => ({
	sign: (k: string, m: string) => Buffer.from(`${k}:${m}`).toString('base64url'),
	region_mac_message: (...parts: unknown[]) => parts.join('|')
}));

const { signing_key, key_fingerprint, reset_signing_key } =
	await import('../src/server/signing-key.ts');

const WARNED = Symbol.for('ogygia.build-key-warned');
const g = globalThis as Record<symbol, unknown>;

beforeEach(() => {
	reset_signing_key();
	delete g[WARNED];
	build.buildHadSecret = false;
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('the signing key', () => {
	it('is read at first use: an env filled after the module loaded still counts', () => {
		vi.stubEnv('OGYGIA_SECRET', 'filled-late-by-the-host');
		const key = signing_key();
		expect(key.secret).toBe('filled-late-by-the-host');
		expect(key.stable).toBe(true);
	});

	it('falls back to the build key without a runtime OGYGIA_SECRET', () => {
		vi.stubEnv('OGYGIA_SECRET', '');
		const key = signing_key();
		expect(key.secret).toBe('build-random-key');
		expect(key.stable).toBe(false);
	});

	it('names its key by a fingerprint: 8 chars, one per key, the same on every instance', () => {
		vi.stubEnv('OGYGIA_SECRET', 'shared-secret');
		const fp = signing_key().fp;
		expect(fp).toHaveLength(8);
		expect(fp).toBe(key_fingerprint('shared-secret'));
		expect(key_fingerprint('another-secret')).not.toBe(fp);
	});

	it('a server whose build had OGYGIA_SECRET but whose runtime has none says so, once', () => {
		vi.stubEnv('DEV', false);
		vi.stubEnv('OGYGIA_SECRET', '');
		build.buildHadSecret = true;
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		signing_key();
		reset_signing_key();
		signing_key();
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0][0])).toContain(
			'was set when this app was built but is not set where it runs'
		);
	});

	it('a production server with no OGYGIA_SECRET anywhere warns, once', () => {
		vi.stubEnv('DEV', false);
		vi.stubEnv('OGYGIA_SECRET', '');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		signing_key();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain('OGYGIA_SECRET is not set');
	});

	it('an env key is silent', () => {
		vi.stubEnv('DEV', false);
		vi.stubEnv('OGYGIA_SECRET', 'a-real-secret');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		signing_key();
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});
});
