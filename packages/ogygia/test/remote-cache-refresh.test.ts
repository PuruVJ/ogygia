import { describe, expect, it } from 'vitest';
import { remote_cache, refresh_remote_instances } from '../src/shims/kit-remote/remote-cache.js';

describe('remote_cache.refresh_instances', () => {
	it('calls refresh and reconnect on live instances', async () => {
		const query_key = 'q-test';
		const live_key = 'l-test';
		let refreshed = 0;
		let reconnected = 0;

		remote_cache.query_map.set(
			query_key,
			new Map([
				[
					'0',
					{
						resource: {
							refresh: async () => {
								refreshed += 1;
							}
						}
					}
				]
			])
		);
		remote_cache.live_query_map.set(
			live_key,
			new Map([
				[
					'0',
					{
						resource: {
							reconnect: async () => {
								reconnected += 1;
							}
						}
					}
				]
			])
		);

		await refresh_remote_instances();
		expect(refreshed).toBe(1);
		expect(reconnected).toBe(1);

		remote_cache.clear_instances();
	});
});
